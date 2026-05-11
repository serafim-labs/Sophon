/**
 * Glue between Sophon (SAP) and OpenClaw (operator role).
 *
 * Wire-up:
 *   - SAP `session.message` arrives via SophonClient.onUpdate
 *   - We start a streaming reply (sendMessage → message_id), then call
 *     OpenClaw `chat.send` with the same text and a stream callback
 *   - Each OpenClaw `text_delta` → SAP sendMessageDelta
 *   - OpenClaw `final` → SAP sendMessageEnd (with usage)
 *   - OpenClaw error → SAP sendMessageEnd with the error text
 *
 * Session mapping: we use the SAP session_id as the OpenClaw
 * `sessionKey` 1-to-1. This relies on the user's OpenClaw being
 * happy to spin up sessions on demand by name (most do).
 */

import { promises as fsp } from 'node:fs'
import { basename, extname } from 'node:path'
import { Buffer } from 'node:buffer'
import {
  blindIndex,
  decryptSymmetric,
  deriveBlindIndexKey,
  deriveBlobKey,
  encryptSymmetric,
} from './crypto.js'
import type { SophonClient, SophonUpdate } from './sophon.js'
import type { OpenClawClient } from './openclaw.js'
import type { SessionKeyStore } from './session-keys.js'
import { formatRunErrorForChat } from './error-messages.js'

/**
 * v1 cap for the file viewer. See docs/FILE_VIEWER_PLAN.md §9.2 — at
 * 1.5 MB a single read finishes inside the WS heartbeat window even on
 * a 1 Mbps link, so we don't need chunking yet. Larger files return
 * `too_large`; the iOS sheet shows the human-readable error.
 */
const FILE_VIEWER_CAP_BYTES = 1.5 * 1024 * 1024

export interface BridgeOpts {
  sophon: SophonClient
  openclaw: OpenClawClient
  log?: (line: string) => void
  /**
   * When true, emit per-delta + per-flush + per-POST stream telemetry
   * to the same `log` sink. Off by default — even with `--verbose` it
   * stays off because the per-delta output (one line per token) drowns
   * everything else. Turn it on with `--debug-stream` /
   * `SOPHON_DEBUG_STREAM=1` when investigating "why isn't streaming
   * working" symptoms.
   */
  debugStream?: boolean
  /**
   * Per-session symmetric key store. Bridge derives blob_keys for
   * messages/tasks/approvals/agent_files from the right session_key
   * for each call. Replaces the pre-0.12.0 install_key model.
   */
  sessionKeyStore: SessionKeyStore
}

export class Bridge {
  private sophon: SophonClient
  private openclaw: OpenClawClient
  private log: (line: string) => void
  private debugStream: boolean
  private sessionKeyStore: SessionKeyStore
  /** Per-sessionKey cache of the last model id we applied via
   *  OpenClaw `sessions.patch`. Used to skip redundant patches on the
   *  hot send path: every `session.message` may carry a `session.model`
   *  hint, but most turns it equals the previous value. Sentinel `''`
   *  means "default / no override" (matches the API surfacing `null`
   *  as "use agent default"). Lazily populated; missing key ⇒ unknown
   *  state ⇒ patch on first observation. */
  private lastAppliedModel = new Map<string, string>()
  /** Per-sessionKey serialisation chain for `ensureSessionModel`. The
   *  chat.send hot path and the dedicated `session.model.changed`
   *  handler both call `ensureSessionModel`; without serialisation a
   *  user changing model mid-send could race two `sessions.patch` RPCs
   *  on the wire and the chat.send that follows the first patch could
   *  see the second patch's value applied (or vice-versa, depending on
   *  arrival order). Chaining ensures patches for the same sessionKey
   *  apply in submission order, the cache is updated synchronously
   *  with the patch's success/failure, and chat.send always sees the
   *  model that the immediately-preceding ensure call requested. */
  private patchChainBySession = new Map<string, Promise<void>>()
  /** Backoff state for permanently-rejected model ids. Without this,
   *  a session pinned to a model id that the gateway's allowedModels
   *  list rejects (e.g. user typed a non-existent id, or the gateway
   *  config dropped the model) loops `sessions.patch` on every send
   *  forever — spamming logs and adding latency. After
   *  MAX_PATCH_FAILURES consecutive failures for the same
   *  (sessionKey, model) tuple we stop attempting until a different
   *  model is requested. */
  private failedModelAttempts = new Map<string, { model: string; count: number }>()
  private static readonly MAX_PATCH_FAILURES = 3

  /** Idempotency ring for incoming `session.message` updates, keyed by
   *  the user message_id the cloud minted in /v1/me/sessions/:id/send.
   *  Defense-in-depth against double-handling: two prod-observed paths
   *  both produce two agent bubbles per user send — a real reply plus a
   *  synthetic `[OpenClaw error] not connected` envelope racing the
   *  same turn:
   *   1. A SECOND bridge process running with the same bot token (the
   *      one that hit us today — a stray `node dist/cli.js openclaw`
   *      from a dev session orphaned itself with PPID=1 while launchd
   *      ran the installed copy alongside it; both got the WS frame).
   *   2. Stale cloud-side WS subscriptions across two fly machines (one
   *      bridge conn lingers on machine A's `connsByInstallation` after
   *      the bridge bounced to B; a publishBridgeEvent on either side
   *      fans to both via pg-bus).
   *  SophonClient already dedupes by `update_id`, but case (1) sees
   *  distinct update_ids because each bridge's local seq counter is
   *  separate — so the dedupe has to live at the per-user-message
   *  layer here. CAP keeps the ring bounded for a long-lived bridge —
   *  at >100 sends/hr it still covers the last several hours, way
   *  past any plausible cloud-fanout retry window. */
  private seenUserMessageIds = new Set<string>()
  private static readonly SEEN_USER_MSG_CAP = 4096

  /** Per-cron-runId Sophon session binding. OpenClaw fires multiple
   *  `event:cron` frames per run (started, progress, completed), all
   *  carrying the same runId. We mint the Sophon session on the FIRST
   *  observation and reuse the binding for the rest of the run.
   *  Cleared when the run finalises so a future run with a recycled
   *  runId mints fresh state. */
  private cronRunSessions = new Map<
    string,
    {
      sessionId: string
      messageId: string
      jobName: string
      accumulated: string
    }
  >()

  constructor(opts: BridgeOpts) {
    this.sophon = opts.sophon
    this.openclaw = opts.openclaw
    this.log = opts.log ?? (() => {})
    this.debugStream = opts.debugStream ?? false
    this.sessionKeyStore = opts.sessionKeyStore
  }

  private dbg(line: string): void {
    // Stream-debug lines bypass the verbose gate — they're explicitly
    // requested via `--debug-stream`. Always go to stderr via the
    // shared sink, prefixed `[stream]` so they're greppable.
    if (!this.debugStream) return
    const t = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
    // Always emit, even if `log` is the default no-op (verbose=false).
    process.stderr.write(`${t} [stream] ${line}\n`)
  }

  start(): void {
    this.sophon.onUpdate(async (u) => this.handleUpdate(u))
    this.sophon.onRequest(async (frame) => this.handleRpcRequest(frame))
    // Cron-fired runs don't have a SAP `session.message` to anchor on
    // — OpenClaw spins them up purely on its own schedule. Subscribe
    // so we can mint a Sophon session lazily and route the run's
    // agent/tool/approval stream into the same SAP surface user-driven
    // chats use; iOS sees them as ordinary chats with `source: 'cron'`.
    this.openclaw.onCronEvent((payload) => {
      void this.handleCronEvent(payload)
    })
  }

  /**
   * Lazy-bind an OpenClaw cron run to a fresh Sophon session.
   *
   * Flow on first frame for a runId:
   *   1. Create a Sophon chat session via /v1/bridge/createSession.
   *      The server publishes `session_created` over SSE so iOS picks
   *      it up in the chats list under `source: 'cron'`.
   *   2. Open a streaming agent message (placeholder bubble).
   *   3. Inject AgentStreamHandlers onto OpenClawClient for this runId
   *      via `registerStreamHandlers`. Subsequent `event:agent`,
   *      `event:chat`, tool, approval frames bound to that runId then
   *      flow through the same delta → SAP fan-out used by the
   *      user-driven `chat.send` path.
   *
   * Subsequent frames for the same runId hit the early-return; the
   * already-registered handlers do the heavy lifting.
   *
   * Failure modes: if `createSession` or `startStreamingMessage` throws
   * we log + bail. The cron run itself still completes on OpenClaw's
   * side — the user just won't see it bridged into iOS for this run.
   * No retry: by the time the next `event:cron` lands, the run may
   * already be near-complete and a half-bridged transcript is worse
   * than no transcript at all.
   */
  private async handleCronEvent(
    payload: import('./openclaw.js').CronEventPayload,
  ): Promise<void> {
    const runId = payload.runId
    if (!runId) return
    if (this.cronRunSessions.has(runId)) return

    let sessionId: string
    let messageId: string
    try {
      const created = await this.sophon.createSession({ source: 'cron' })
      sessionId = created.sessionId
    } catch (err) {
      this.log(`[bridge] cron createSession failed runId=${runId}: ${(err as Error).message}`)
      return
    }
    try {
      const started = await this.sophon.startStreamingMessage({ sessionId })
      messageId = started.messageId
    } catch (err) {
      this.log(`[bridge] cron startStreamingMessage failed runId=${runId} sessionId=${sessionId}: ${(err as Error).message}`)
      return
    }

    const binding = {
      sessionId,
      messageId,
      jobName: payload.jobName ?? '',
      accumulated: '',
    }
    this.cronRunSessions.set(runId, binding)
    this.log(
      `[bridge] cron run bound runId=${runId} jobId=${payload.jobId ?? '?'} jobName=${binding.jobName} sessionId=${sessionId}`,
    )

    // Serialise non-delta side-effects (tool create/update/finish,
    // approvals, sendEnd) per run. Same shape as the user-chat path:
    // order matters between create→update→finish; sendEnd must come
    // last. Deltas use a separate, batched POST chain (no per-token
    // round-trips) — see user-chat path for the same trick.
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (work: () => Promise<void>) => {
      chain = chain.then(work).catch((err) => {
        this.log(`[bridge] cron sophon push failed runId=${runId}: ${(err as Error).message}`)
      })
    }

    this.openclaw.registerStreamHandlers(runId, {
      onTextDelta: (delta) => {
        binding.accumulated += delta
        enqueue(() => this.sophon.sendDelta({ messageId, sessionId, delta }))
      },
      onFinal: (final) => {
        // Same logic as the user-chat path: skip `text` if we streamed
        // bytes (server already has them); fall back only on tool-only
        // turns where nothing streamed.
        const fallbackText = binding.accumulated.length === 0
          ? (final.text || '')
          : undefined
        enqueue(async () => {
          await this.sophon.sendEnd({
            messageId,
            sessionId,
            ...(fallbackText !== undefined ? { text: fallbackText } : {}),
            usage: final.usage,
          })
          this.cronRunSessions.delete(runId)
        })
      },
      onError: (msg) => {
        enqueue(async () => {
          await this.sophon.sendEnd({
            messageId,
            sessionId,
            ...(binding.accumulated.length === 0
              ? { text: formatRunErrorForChat(msg) }
              : {}),
          })
          this.cronRunSessions.delete(runId)
        })
      },
      onTool: (ev) => {
        const argsSummary = summarizeArgs(ev.args)
        const statusLabel = ev.phase === 'start'
          ? `${ev.name}${argsSummary ? ` ${argsSummary}` : ''}`
          : undefined
        switch (ev.phase) {
          case 'start':
            enqueue(() => this.sophon.createTask({
              sessionId,
              taskId: ev.toolCallId,
              kind: ev.name,
              statusLabel,
              args: ev.args,
            }))
            void this.trackToolFile(sessionId, ev.name, ev.args)
            return
          case 'update':
            enqueue(() => this.sophon.updateTask({
              sessionId,
              taskId: ev.toolCallId,
              partialResult: ev.partialResult,
            }))
            return
          case 'result': {
            const ok = !ev.isError
            const errString = ev.isError
              ? (typeof ev.result === 'string'
                  ? ev.result
                  : safeStringify(ev.result))
              : undefined
            enqueue(() => this.sophon.finishTask({
              sessionId,
              taskId: ev.toolCallId,
              name: ev.name,
              status: ok ? 'completed' : 'failed',
              ...(errString ? { error: errString } : {}),
              ...(ok ? { result: ev.result } : {}),
            }))
            return
          }
        }
      },
      onApproval: (ev) => {
        if (ev.phase !== 'requested') return
        const approvalId = ev.approvalId
        if (!approvalId) {
          this.log(`[bridge] cron approval.requested missing approvalId — dropping runId=${runId}`)
          return
        }
        const action = ev.kind === 'plugin' ? 'plugin.invoke' : 'shell.exec'
        const trimmedMsg = ev.message?.trim()
        const messageBody = (trimmedMsg && trimmedMsg.length > 0)
          ? trimmedMsg
          : (ev.command ? `Run \`${ev.command}\`?` : ev.title)
        const severity = ev.status === 'unavailable' ? 'critical' : 'medium'
        enqueue(() => this.sophon.requestApproval({
          sessionId,
          approvalId,
          approvalSlug: ev.approvalSlug,
          action,
          toolCallId: ev.toolCallId,
          title: ev.title,
          severity,
          command: ev.command,
          host: ev.host,
          message: messageBody,
        }))
      },
    })
  }

  /**
   * Server → bridge RPC dispatch. Currently only `file.read.req` (file
   * viewer) but anything that should run in the bridge process (capability
   * probes, debug introspection) lands here.
   *
   * Returns the reply payload; the SophonClient adds the `req_id` /
   * `type=*.resp` envelope. Errors go back as `{ error: { code, ... } }`
   * with a known code so the server route can map to HTTP status.
   */
  private async handleRpcRequest(
    frame: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const type = String(frame.type ?? '')
    if (type === 'file.read.req') return this.handleFileRead(frame)
    if (type === 'models.list.req') return this.handleModelsList()
    if (type === 'cron.list.req') return this.handleCronRpc('list', frame)
    if (type === 'cron.status.req') return this.handleCronRpc('status', frame)
    if (type === 'cron.add.req') return this.handleCronRpc('add', frame)
    if (type === 'cron.update.req') return this.handleCronRpc('update', frame)
    if (type === 'cron.remove.req') return this.handleCronRpc('remove', frame)
    if (type === 'cron.run.req') return this.handleCronRpc('run', frame)
    if (type === 'cron.runs.req') return this.handleCronRpc('runs', frame)
    return { error: { code: 'unknown_request', type } }
  }

  /**
   * Routines live in OpenClaw — the bridge is a thin proxy. Sophon
   * server forwards `cron.<verb>.req` from iOS, we hand the params
   * through to the gateway's `cron.<verb>` server-method, and pass the
   * raw result back. Wire shapes are documented in
   * `reference/openclaw-full/src/gateway/protocol/schema/cron.ts`.
   */
  private async handleCronRpc(
    verb: 'list' | 'status' | 'add' | 'update' | 'remove' | 'run' | 'runs',
    frame: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const params = (frame.params ?? {}) as Record<string, unknown>
    try {
      const result = await (() => {
        switch (verb) {
          case 'list': return this.openclaw.cronList(params)
          case 'status': return this.openclaw.cronStatus()
          case 'add': return this.openclaw.cronAdd(params)
          case 'update': return this.openclaw.cronUpdate(params)
          case 'remove': return this.openclaw.cronRemove(params)
          case 'run': return this.openclaw.cronRun(params)
          case 'runs': return this.openclaw.cronRuns(params)
        }
      })()
      // Gateway returns raw result objects (CronJob, list, etc.);
      // wrap so the server route can inspect `error` vs payload.
      return { result: (result ?? {}) as Record<string, unknown> }
    } catch (err) {
      return {
        error: {
          code: `cron_${verb}_failed`,
          message: (err as Error).message,
        },
      }
    }
  }

  /**
   * Surfaces OpenClaw's `models.list` to the SAP server so iOS can
   * populate the composer's model picker dynamically. The catalog is
   * the gateway's allowedModels intersected with the loaded provider
   * registry — exactly what `entry.modelOverride` (set via
   * `sessions.patch`) is allowed to take. iOS uses entry `id` as the
   * value to PATCH back.
   */
  private async handleModelsList(): Promise<Record<string, unknown>> {
    try {
      const result = await this.openclaw.modelsList()
      return { models: result.models }
    } catch (err) {
      return { error: { code: 'models_list_failed', message: (err as Error).message } }
    }
  }

  /**
   * File viewer read handler. Two checks:
   *
   *   1. realpath(requested) === realpath(serverVouchedPath) — the
   *      server already gated on session_agent_files, so the symlink
   *      defense here ensures `?path=~/.ssh/key` (which the agent
   *      legitimately read) can't be hijacked into reading a different
   *      target via a symlink swap mid-session.
   *   2. fs.stat → size cap (1.5 MB v1; matches plan §9.2 heartbeat
   *      analysis). Larger files return `too_large` with the actual
   *      size so the iOS sheet can show the human-readable error.
   *
   * `icloud_not_local` detection is best-effort via fs.stat flags
   * (NSFileBrowserContentsNotDownloaded is reflected in the dataless
   * APFS entry — `stat` returns the file but reading would block on
   * download). For now we attempt the read and surface ENOENT-like
   * errors as `not_found`; a follow-up can introspect macOS-specific
   * xattr / fcntl flags for a clean signal.
   */
  private async handleFileRead(
    frame: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Two modes (server picks based on iOS query string, bridge
    // dispatches by which fields are present):
    //
    //   • Legacy plaintext: { path, server_vouched_path }
    //     bridge realpath-checks both and returns plaintext bytes.
    //
    //   • E2E ciphertext:   { session_id, blind_idx, path_ct }
    //     bridge derives blob_key from install_key, decrypts path_ct
    //     to plaintext path, realpath-checks that against itself,
    //     reads the file, encrypts the response bytes with the same
    //     blob_key, and sets `encrypted: true` on the reply.
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    const blindIdx = typeof frame.blind_idx === 'string' ? frame.blind_idx : ''
    const pathCtBase64 = typeof frame.path_ct === 'string' ? frame.path_ct : ''
    const requestedPlain = typeof frame.path === 'string' ? frame.path : ''
    const vouchedPlain = typeof frame.server_vouched_path === 'string' ? frame.server_vouched_path : ''

    let plaintextPath: string
    let blobKey: Uint8Array | null = null

    if (sessionId && blindIdx && pathCtBase64) {
      // E2E mode. session_key required — must have been granted by
      // a sibling device or generated locally before this request.
      const sessionKey = this.sessionKeyStore.get(sessionId)
      if (!sessionKey) {
        return { error: { code: 'no_session_key' } }
      }
      try {
        blobKey = deriveBlobKey(
          sessionKey,
          `agent_files/${sessionId}/${blindIdx}`,
        )
      } catch (err: unknown) {
        return { error: { code: 'crypto_failed', message: (err as Error)?.message } }
      }
      const pathEnvelope = Buffer.from(pathCtBase64, 'base64')
      const pathPlainBytes = decryptSymmetric(new Uint8Array(pathEnvelope), blobKey)
      if (!pathPlainBytes) {
        // AEAD failure — mismatched key (install_key from a different
        // pairing, or tampered ciphertext). Surface as forbidden so
        // the iOS sheet shows the right copy.
        return { error: { code: 'forbidden' } }
      }
      plaintextPath = new TextDecoder().decode(pathPlainBytes)
    } else if (requestedPlain && vouchedPlain) {
      // Legacy plaintext mode.
      let realRequested: string
      let realVouched: string
      try {
        realRequested = await fsp.realpath(requestedPlain)
        realVouched = await fsp.realpath(vouchedPlain)
      } catch (err: unknown) {
        const code = errnoCode(err)
        if (code === 'ENOENT') return { error: { code: 'not_found' } }
        if (code === 'EACCES') return { error: { code: 'permission_denied' } }
        return { error: { code: 'unknown', message: (err as Error)?.message } }
      }
      if (realRequested !== realVouched) {
        return { error: { code: 'forbidden' } }
      }
      plaintextPath = realRequested
    } else {
      return { error: { code: 'invalid_request' } }
    }

    // realpath the (possibly-decrypted) plaintext path. Symlink
    // defense in depth: even with valid AEAD-authenticated ciphertext,
    // the named target on disk could be a symlink leading outside the
    // session-touched set. realpath collapses it; the original
    // notifyToolFile already realpath'd before encrypting, so a
    // legitimate row's decrypted path SHOULD already be canonical
    // and this check is a no-op. Mismatch ⇒ disk state changed
    // since notify ⇒ refuse.
    let real: string
    try {
      real = await fsp.realpath(plaintextPath)
    } catch (err: unknown) {
      const code = errnoCode(err)
      if (code === 'ENOENT') return { error: { code: 'not_found' } }
      if (code === 'EACCES') return { error: { code: 'permission_denied' } }
      return { error: { code: 'unknown', message: (err as Error)?.message } }
    }
    if (real !== plaintextPath) {
      return { error: { code: 'forbidden' } }
    }

    let stat: { size: number }
    try {
      stat = await fsp.stat(real)
    } catch (err: unknown) {
      const code = errnoCode(err)
      if (code === 'ENOENT') return { error: { code: 'not_found' } }
      if (code === 'EACCES') return { error: { code: 'permission_denied' } }
      return { error: { code: 'unknown', message: (err as Error)?.message } }
    }

    if (stat.size > FILE_VIEWER_CAP_BYTES) {
      return { error: { code: 'too_large', size_bytes: stat.size } }
    }

    let buf: Buffer
    try {
      buf = await fsp.readFile(real)
    } catch (err: unknown) {
      const code = errnoCode(err)
      if (code === 'ENOENT') return { error: { code: 'not_found' } }
      if (code === 'EACCES') return { error: { code: 'permission_denied' } }
      return { error: { code: 'unknown', message: (err as Error)?.message } }
    }

    const mime = detectMime(real, buf)
    if (blobKey) {
      // E2E mode — encrypt the bytes with the same blob_key the iOS
      // side will derive. mime stays plaintext (3-letter category,
      // not sensitive); size_bytes stays plaintext for the cap copy.
      let cipherEnvelope: Uint8Array
      try {
        cipherEnvelope = encryptSymmetric(new Uint8Array(buf), blobKey)
      } catch (err: unknown) {
        return { error: { code: 'crypto_failed', message: (err as Error)?.message } }
      }
      return {
        mime_type: mime,
        size_bytes: stat.size,
        base64: Buffer.from(cipherEnvelope).toString('base64'),
        encrypted: true,
      }
    }

    return {
      mime_type: mime,
      size_bytes: stat.size,
      base64: buf.toString('base64'),
    }
  }

  private async handleUpdate(u: SophonUpdate): Promise<void> {
    switch (u.type) {
      case 'session.message':
        await this.handleSessionMessage(u)
        return
      case 'session.started':
        // Nothing to do — OpenClaw spins up a session lazily when we
        // first call chat.send with a new sessionKey.
        return
      case 'session.cancelled':
        await this.handleSessionCancelled(u)
        return
      case 'session.model.changed':
        await this.handleSessionModelChanged(u)
        return
      case 'approval.resolved':
        await this.handleApprovalResolved(u)
        return
      case 'installation.created':
      case 'installation.revoked':
        return
      case 'device_added':
        await this.handleDeviceAdded(u)
        return
      case 'session_key_granted':
        await this.handleSessionKeyGranted(u)
        return
      case 'device_revoked':
        // Surviving iOS device(s) will rotate session_keys client-side
        // and POST grants; we receive those as ordinary
        // session_key_granted events and overwrite our local session_key
        // (SessionKeyStore.set is overwrite-by-default). Nothing to do
        // here beyond logging — left as a hook in case we later want to
        // proactively drop cached state.
        this.log(`[bridge] device_revoked id=${(u.payload as { device_id?: string })?.device_id ?? '?'}`)
        return
      default:
        this.log(`[bridge] ignoring update type ${u.type}`)
    }
  }

  /** Sibling device joined the user account — wrap every session_key
   *  we hold under the new device's pubkey and POST grants. The bridge
   *  is the durable always-online grantor for cold-handoff cases (no
   *  iOS device awake to do the wrap itself). */
  private async handleDeviceAdded(u: SophonUpdate): Promise<void> {
    const payload = u.payload as {
      device_id?: string
      pubkey?: string
      label?: string
      platform?: string
      installation_id?: string | null
    }
    const deviceId = payload?.device_id
    const pubkeyHex = payload?.pubkey
    if (!deviceId || typeof pubkeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(pubkeyHex)) {
      this.log(`[bridge] device_added: malformed payload, ignoring`)
      return
    }
    // Don't grant to ourselves — we already hold every session_key
    // in plaintext locally. Server lets us post anyway, but it would
    // overwrite the existing self-recipient row uselessly.
    if (payload.platform === 'bridge') return

    // Lazy-import to avoid a circular reference between bridge.ts and
    // crypto.ts at module-load time. (The dynamic import resolves the
    // sealed-box primitive after both modules have finished initial
    // evaluation.)
    const { sealedBoxEncrypt } = await import('./crypto.js')
    const recipientPubkey = new Uint8Array(Buffer.from(pubkeyHex, 'hex'))

    const entries = this.sessionKeyStore.entries()
    if (entries.length === 0) return

    // Group by sessionId (one POST per session for now — bulk inside
    // the array). Bridge typically has 1-10 sessions; keep it simple.
    let granted = 0
    for (const [sessionId, sessionKey] of entries) {
      try {
        const wrapped = sealedBoxEncrypt(sessionKey, recipientPubkey)
        const wrappedB64 = Buffer.from(wrapped).toString('base64')
        await this.sophon.postBridgeSessionRecipients({
          sessionId,
          recipients: [{ deviceId, wrappedSessionKeyB64: wrappedB64 }],
          ...(this.bridgeDeviceId ? { wrappedByDeviceId: this.bridgeDeviceId } : {}),
        })
        granted++
      } catch (err) {
        this.log(`[bridge] grant ${sessionId} → ${deviceId} failed: ${(err as Error).message}`)
      }
    }
    this.log(`[bridge] device_added ${deviceId} — granted ${granted}/${entries.length} sessions`)
  }

  /** Server forwarded a session_key from a sibling that wrapped it
   *  for our pubkey. Unwrap, store. Used when the bridge wasn't the
   *  session creator (rare in OpenClaw flows; iOS-creates-session is
   *  the typical path). */
  private async handleSessionKeyGranted(u: SophonUpdate): Promise<void> {
    const payload = u.payload as {
      session_id?: string
      device_id?: string
      wrapped_session_key?: string
    }
    const sessionId = payload?.session_id
    const wrappedB64 = payload?.wrapped_session_key
    if (!sessionId || typeof wrappedB64 !== 'string') {
      this.log(`[bridge] session_key_granted: malformed payload`)
      return
    }
    if (payload.device_id && this.bridgeDeviceId && payload.device_id !== this.bridgeDeviceId) {
      // Grant addressed to a different device — server should have
      // filtered, but be defensive.
      return
    }
    if (!this.bridgeSecretKey) {
      this.log(`[bridge] session_key_granted: no bridge secret key on hand`)
      return
    }
    try {
      const { sealedBoxDecrypt } = await import('./crypto.js')
      const envelope = new Uint8Array(Buffer.from(wrappedB64, 'base64'))
      const plain = sealedBoxDecrypt(envelope, this.bridgeSecretKey)
      if (!plain || plain.length !== 32) {
        this.log(`[bridge] session_key_granted ${sessionId}: unwrap failed or wrong length`)
        return
      }
      await this.sessionKeyStore.set(sessionId, plain)
      this.log(`[bridge] session_key_granted ${sessionId} stored`)
    } catch (err) {
      this.log(`[bridge] session_key_granted ${sessionId} errored: ${(err as Error).message}`)
    }
  }

  /** Late-bound device id + secret — set by the orchestrator after
   *  POST /v1/bridge/devices completes. Both must be set before we
   *  can do `wrappedByDeviceId` audit attribution or unwrap incoming
   *  grants in `handleSessionKeyGranted`. */
  private bridgeDeviceId: string | null = null
  private bridgeSecretKey: Uint8Array | null = null
  setBridgeIdentity(deviceId: string, secretKey: Uint8Array): void {
    this.bridgeDeviceId = deviceId
    this.bridgeSecretKey = secretKey
  }

  /**
   * iOS user tapped Stop on an in-flight reply → server emitted
   * `session.cancelled` with `{ session: { id }, reason }`. Forward as
   * OpenClaw `chat.abort` so the gateway tears down the live run and
   * persists any partial output. We pass `sessionKey` only (no
   * `runId`) so the gateway aborts every live run for the chat — the
   * user's intent is "stop this chat", not "stop run X".
   *
   * Failure is logged + swallowed: the cancel may race the gateway
   * finalising on its own (run completed during the user's tap), in
   * which case `chat.abort` returns `aborted: false` but everything
   * downstream is already consistent.
   */
  private async handleSessionCancelled(u: SophonUpdate): Promise<void> {
    const payload = u.payload as { session?: { id?: string }; reason?: string }
    const sessionId = payload.session?.id ?? u.session_id
    if (!sessionId) {
      this.log(`[bridge] session.cancelled missing session.id`)
      return
    }
    try {
      await this.openclaw.chatAbort({ sessionKey: sessionId })
    } catch (err) {
      this.log(
        `[bridge] chat.abort RPC failed sessionKey=${sessionId}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * iOS user resolved an approval → server published
   * `approval.resolved` to bridge-bus → SophonClient routed it through
   * `onUpdate`. Forward the user's decision to OpenClaw via the
   * matching `*.approval.resolve` RPC.
   */
  private async handleApprovalResolved(u: SophonUpdate): Promise<void> {
    const payload = u.payload as {
      approval_id?: string
      decision?: string
    }
    const approvalId = payload.approval_id
    const userDecision = payload.decision
    if (!approvalId || !userDecision) {
      this.log(`[bridge] approval.resolved missing approval_id/decision`)
      return
    }
    // Map SAP iOS decision → OpenClaw gateway decision.
    //   approve         → allow-once  (allow this single command)
    //   approve_always  → allow-always (persist a grant on the install)
    //   deny            → deny
    let openclawDecision: 'allow-once' | 'allow-always' | 'deny'
    switch (userDecision) {
      case 'approve':         openclawDecision = 'allow-once'; break
      case 'approve_always':  openclawDecision = 'allow-always'; break
      case 'deny':            openclawDecision = 'deny'; break
      default:
        this.log(`[bridge] approval.resolved unknown decision=${userDecision}`)
        return
    }
    try {
      await this.openclaw.respondApproval({ approvalId, decision: openclawDecision })
    } catch (err) {
      this.log(`[bridge] approval.resolve RPC failed: ${(err as Error).message}`)
    }
  }

  /**
   * Apply the per-session model override on OpenClaw if it differs
   * from the last value we patched for this `sessionKey`. Called both
   * from the dedicated `session.model.changed` update AND inline from
   * the hot `session.message` path — every message payload carries
   * the current `session.model` so a user who taps the model sheet
   * immediately followed by Send sees the new model applied even if
   * the cross-WS `session.model.changed` didn't land first.
   *
   * **Serialised per sessionKey** via `patchChainBySession` so two
   * concurrent calls (e.g. message + model-change interleave) cannot
   * race their `sessions.patch` RPCs on the wire — without this the
   * patch the chat.send awaited could be overtaken by a later patch
   * before chat.send fires, applying the wrong model to the run.
   *
   * **Bounded retry on permanent failure**: the gateway rejects
   * unknown / disallowed model ids with the same error every time;
   * after `MAX_PATCH_FAILURES` consecutive failures for the same
   * `(sessionKey, model)` tuple, subsequent calls log + skip the RPC
   * until a different model is requested. Prevents an infinite-retry
   * loop on every send for a session pinned to a bad id.
   *
   * Idempotent on the gateway side; the local cache only avoids the
   * round-trip on no-op turns. `desired === null` (or empty) ⇒ "use
   * agent default" ⇒ clear override on OpenClaw. Stored as `''`
   * sentinel in the cache so a freshly-set null doesn't look like
   * "unknown state".
   */
  private async ensureSessionModel(
    sessionKey: string,
    desired: string | null,
  ): Promise<void> {
    const prev = this.patchChainBySession.get(sessionKey) ?? Promise.resolve()
    const work = prev.then(() => this.applySessionModel(sessionKey, desired))
    // Always store the latest tail; cleanup once it settles so an idle
    // session doesn't pin a resolved promise forever.
    this.patchChainBySession.set(sessionKey, work)
    work.finally(() => {
      if (this.patchChainBySession.get(sessionKey) === work) {
        this.patchChainBySession.delete(sessionKey)
      }
    })
    return work
  }

  /** Inner body of `ensureSessionModel`. Runs serially per sessionKey
   *  via the chain in `ensureSessionModel`. Caller MUST not invoke
   *  directly — that would defeat the serialisation. */
  private async applySessionModel(
    sessionKey: string,
    desired: string | null,
  ): Promise<void> {
    const next = desired ?? ''
    const last = this.lastAppliedModel.get(sessionKey)
    if (last !== undefined && last === next) return

    // Bounded-retry guard. If the previous N attempts for this exact
    // (sessionKey, model) all failed, the gateway is rejecting it for
    // a permanent reason (unknown id, disallowed by config); retrying
    // every send wastes a round-trip. The guard is cleared as soon as
    // a different `next` value is requested — switching model unblocks
    // a session that got pinned to a bad id.
    const failure = this.failedModelAttempts.get(sessionKey)
    if (failure && failure.model === next && failure.count >= Bridge.MAX_PATCH_FAILURES) {
      // Already warned at the threshold-crossing call; downgrade follow-
      // ups to a single dbg line so we don't spam the operator log.
      this.dbg(
        `sessions.patch skipped sessionKey=${sessionKey} model=${next || 'null'} — quarantined after ${failure.count} failures`,
      )
      return
    }

    try {
      await this.openclaw.sessionsPatch({ sessionKey, model: next === '' ? null : next })
      this.lastAppliedModel.set(sessionKey, next)
      this.failedModelAttempts.delete(sessionKey)
    } catch (err) {
      const failureCount =
        failure && failure.model === next ? failure.count + 1 : 1
      this.failedModelAttempts.set(sessionKey, { model: next, count: failureCount })
      const tail =
        failureCount >= Bridge.MAX_PATCH_FAILURES
          ? ` — quarantining (will skip until model changes)`
          : ` — will retry on next send`
      this.log(
        `[bridge] sessions.patch failed sessionKey=${sessionKey} model=${next || 'null'} attempt=${failureCount}: ${(err as Error).message}${tail}`,
      )
      // Don't poison `lastAppliedModel` — leave it unset so a future
      // call with the same `next` still attempts (until quarantined).
      // The send proceeds with whatever model the gateway already had
      // applied; better a slightly-stale model than a dropped turn.
    }
  }

  /**
   * iOS user picked a different model in the composer sheet → server
   * persisted on `chat_sessions.model` and pushed `session.model.changed`
   * here. Forward to OpenClaw via `sessions.patch`. The session.message
   * hot path also carries the current model and runs the same RPC, so
   * this update mainly matters for "user picks model but doesn't send"
   * — without it the next turn would race the patch against chat.send.
   */
  private async handleSessionModelChanged(u: SophonUpdate): Promise<void> {
    const payload = u.payload as { session?: { id?: string }; model?: string | null }
    const sessionId = payload.session?.id ?? u.session_id
    if (!sessionId) {
      this.log(`[bridge] session.model.changed missing session.id`)
      return
    }
    const model = typeof payload.model === 'string' && payload.model.length > 0
      ? payload.model
      : null
    await this.ensureSessionModel(sessionId, model)
  }

  private async handleSessionMessage(u: SophonUpdate): Promise<void> {
    const payload = u.payload as {
      session?: { id?: string; model?: string | null }
      message?: {
        id?: string
        text?: string
        text_ct?: string
        attachments?: Array<{
          key?: string
          url?: string
          mime?: string
          name?: string | null
        }>
      }
    }
    const sessionId = payload.session?.id ?? u.session_id ?? ''
    // Per-user-message idempotency guard — drops the second invocation
    // when a second bridge process or a stale cloud subscription
    // delivers the same `session.message` again. See seenUserMessageIds
    // field docs for the full story. The cloud's user-message_id is
    // unique per /v1/me/sessions/:id/send, so it's the right dedup key.
    const msgId = payload.message?.id
    if (msgId) {
      if (this.seenUserMessageIds.has(msgId)) {
        this.log(`[bridge] duplicate session.message user_msg_id=${msgId} update_id=${u.update_id} — dropped`)
        return
      }
      this.seenUserMessageIds.add(msgId)
      if (this.seenUserMessageIds.size > Bridge.SEEN_USER_MSG_CAP) {
        const first = this.seenUserMessageIds.values().next().value
        if (first !== undefined) this.seenUserMessageIds.delete(first)
      }
    }
    // E2E mode: server-blind iOS encrypted the user's text. Decrypt
    // with the per-session messages blob_key derived from install_key.
    // OpenClaw expects plaintext; the bridge is the trust boundary.
    let text = payload.message?.text ?? ''
    const textCt = payload.message?.text_ct
    if (textCt) {
      const sessionKey = this.sessionKeyStore.get(sessionId)
      if (!sessionKey) {
        this.log(`[bridge] decrypt session.message: no session_key for ${sessionId}`)
      } else {
        try {
          const blobKey = deriveBlobKey(sessionKey, `messages/${sessionId}`)
          const envelope = Buffer.from(textCt, 'base64')
          const plain = decryptSymmetric(new Uint8Array(envelope), blobKey)
          if (plain) {
            text = new TextDecoder().decode(plain)
          } else {
            this.log(`[bridge] decrypt session.message text failed — falling back to plaintext`)
          }
        } catch (err) {
          this.log(`[bridge] decrypt session.message text errored: ${(err as Error).message}`)
        }
      }
    }
    if (!sessionId || !text) {
      this.log(`[bridge] dropping session.message — missing sessionId or text`)
      return
    }
    // OpenClaw's `chat.send` attachment normaliser
    // (`attachment-normalize-*.js` in its dist) accepts only
    // `{ mimeType, fileName, content: <base64> }`. Earlier we forwarded
    // the signed `{ url, mime, name }` shape from the server thinking
    // OpenClaw would fetch — it doesn't, the unknown fields were
    // silently dropped, and the model replied "не вижу вложений" on
    // every image send. Fetch each URL, decode to base64, hand
    // OpenClaw the exact shape it expects.
    const rawAttachments = payload.message?.attachments ?? []
    const attachments: Array<{ mimeType: string; fileName: string; content: string }> = []
    for (const a of rawAttachments) {
      if (typeof a.url !== 'string' || !a.url) continue
      if (typeof a.mime !== 'string' || !a.mime) continue
      try {
        const resp = await fetch(a.url)
        if (!resp.ok) {
          this.log(`[bridge] attachment fetch ${a.url.slice(0, 80)} → HTTP ${resp.status} — skip`)
          continue
        }
        const buf = Buffer.from(await resp.arrayBuffer())
        attachments.push({
          mimeType: a.mime,
          fileName: a.name ?? `attachment-${attachments.length + 1}`,
          content: buf.toString('base64'),
        })
      } catch (err) {
        this.log(`[bridge] attachment fetch failed: ${(err as Error).message}`)
      }
    }

    // Apply the per-session model override BEFORE chat.send so the
    // gateway resolves `entry.modelOverride` to the right value when
    // it spins up (or continues) the run. `payload.session.model` is
    // the canonical wire field; `null` / undefined ⇒ "use agent
    // default". Cached per sessionKey so repeated turns with the same
    // model are a single in-process branch, no round-trip.
    const desiredModel = (() => {
      const raw = (payload.session as { model?: string | null } | undefined)?.model
      return typeof raw === 'string' && raw.length > 0 ? raw : null
    })()
    await this.ensureSessionModel(sessionId, desiredModel)

    // 1. Pre-create a streaming agent message in Sophon so iOS sees a
    //    placeholder bubble immediately (otherwise the user waits in
    //    silence while OpenClaw chews on the prompt).
    const interactionId = u.interaction_id
    const { messageId } = await this.sophon.startStreamingMessage({
      sessionId,
      interactionId,
    })

    let accumulated = ''

    // Side-channel queue for non-delta side effects (approvals, task
    // create/update/finish, sendEnd). Strict-serial because order
    // matters: a `task.update` mustn't overtake a `task.create` for
    // the same toolCallId, and `sendEnd` must happen after the last
    // pending task/approval flush.
    let pendingPromise: Promise<void> = Promise.resolve()
    const enqueue = (work: () => Promise<void>) => {
      pendingPromise = pendingPromise.then(work).catch((err) => {
        this.log(`[bridge] sophon push failed: ${(err as Error).message}`)
      })
    }

    // ─── Delta batcher ──────────────────────────────────────────────
    //
    // OpenClaw streams text at ~50–200 tokens/s. The original code
    // POST'd each token via a serialised `pendingPromise.then(...)`
    // chain — on a 100ms RTT to api.sophon.at that means the tail
    // delta lands ~10s after OpenClaw finished, and `sendEnd` (with
    // the full final text) overtakes the visible stream. Result: the
    // user sees the whole reply pop in at once.
    //
    // Fix: coalesce deltas into 40ms windows. One in-flight POST max
    // (preserves on-wire ordering); during a flight new deltas pile
    // into `buffer`, and the next flush sends them all in one go.
    // ~20× fewer round-trips, no perceptible lag at 40ms cadence
    // (well under the ~50ms human flicker-fusion threshold), and
    // `sendEnd` cleanly waits for the buffer to drain before firing.
    const FLUSH_INTERVAL_MS = 40
    let deltaBuffer = ''
    let deltaInFlight = false
    let deltaTimer: NodeJS.Timeout | null = null
    let drainResolvers: Array<() => void> = []
    let deltaCount = 0
    let flushCount = 0
    const turnStartedAt = Date.now()
    const notifyDrainedIfIdle = () => {
      if (deltaBuffer.length > 0 || deltaInFlight) return
      if (drainResolvers.length === 0) return
      const cbs = drainResolvers
      drainResolvers = []
      for (const cb of cbs) cb()
    }
    const flushDeltaBuffer = async (): Promise<void> => {
      if (deltaBuffer.length === 0) {
        notifyDrainedIfIdle()
        return
      }
      deltaInFlight = true
      const chunk = deltaBuffer
      deltaBuffer = ''
      flushCount++
      const flushNum = flushCount
      const t0 = Date.now()
      this.dbg(`flush #${flushNum} START len=${chunk.length} ${JSON.stringify(chunk.slice(0, 60))}${chunk.length > 60 ? '…' : ''}`)
      try {
        await this.sophon.sendDelta({ messageId, sessionId, delta: chunk })
        this.dbg(`flush #${flushNum} OK   took=${Date.now() - t0}ms`)
      } catch (err) {
        // Drop the chunk on failure — the server's row already has
        // every previously-applied delta in `messages.text`, and
        // `sendEnd` (with its synthetic full-text fallback below)
        // will repair the visible bubble. Logging only.
        this.log(`[bridge] sendDelta failed: ${(err as Error).message}`)
        this.dbg(`flush #${flushNum} FAIL took=${Date.now() - t0}ms err=${(err as Error).message}`)
      } finally {
        deltaInFlight = false
      }
      // Coalesce: if more arrived during the POST, flush again
      // immediately rather than waiting for another timer tick.
      if (deltaBuffer.length > 0) {
        void flushDeltaBuffer()
      } else {
        notifyDrainedIfIdle()
      }
    }
    const scheduleDeltaFlush = () => {
      if (deltaTimer || deltaInFlight) return
      deltaTimer = setTimeout(() => {
        deltaTimer = null
        void flushDeltaBuffer()
      }, FLUSH_INTERVAL_MS)
    }
    const drainDeltas = (): Promise<void> => {
      if (deltaBuffer.length === 0 && !deltaInFlight) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => { drainResolvers.push(resolve) })
    }

    this.dbg(`turn START messageId=${messageId} sessionId=${sessionId}`)

    // 2. Hand the OpenClaw call its stream handlers — fire-and-forget
    //    sendDelta / sendEnd back into Sophon. Tool events fan out
    //    onto the SAP task_* surface so iOS shows the live tool deck
    //    while the run is in flight.
    try {
      await this.openclaw.chatSend({
        sessionKey: sessionId,
        message: text,
        attachments,
        handlers: {
          onTextDelta: (delta) => {
            accumulated += delta
            deltaBuffer += delta
            deltaCount++
            this.dbg(`delta #${deltaCount} len=${delta.length} acc=${accumulated.length} buf=${deltaBuffer.length} inFlight=${deltaInFlight} timer=${deltaTimer ? 'set' : '-'} +${Date.now() - turnStartedAt}ms`)
            scheduleDeltaFlush()
          },
          onFinal: (final) => {
            // Order: drain all queued tool/approval ops, then drain
            // the delta buffer, THEN sendEnd. Without the drain,
            // sendEnd would race ahead of the final delta(s) and the
            // server would 409 them with `message_finalized`.
            //
            // ALWAYS send the canonical full text on sendEnd. Server
            // `/v1/bridge/sendMessageDelta` only forwards deltas over
            // SSE — it never accumulates them into `messages.text_ct`.
            // Without `text` here the row's text_ct stays NULL → next
            // history fetch returns an empty bubble, and iOS' in-memory
            // copy is also clobbered by the empty `message_finalized`
            // payload. Prefer our accumulated string (what iOS actually
            // saw stream); fall back to `final.text` when nothing
            // streamed (tool-only turns).
            const finalText = accumulated.length > 0
              ? accumulated
              : (final.text || '')
            this.dbg(`onFinal triggered deltaCount=${deltaCount} acc=${accumulated.length} finalTextLen=${(final.text ?? '').length} sentLen=${finalText.length} +${Date.now() - turnStartedAt}ms`)
            enqueue(async () => {
              this.dbg(`sendEnd START drainStart=${Date.now() - turnStartedAt}ms`)
              await drainDeltas()
              const t0 = Date.now()
              await this.sophon.sendEnd({
                messageId,
                sessionId,
                text: finalText,
                usage: final.usage,
              })
              this.dbg(`sendEnd OK    took=${Date.now() - t0}ms totalTurn=${Date.now() - turnStartedAt}ms flushes=${flushCount} deltas=${deltaCount}`)
            })
          },
          onError: (msg) => {
            this.dbg(`onError "${msg}" acc=${accumulated.length} +${Date.now() - turnStartedAt}ms`)
            enqueue(async () => {
              await drainDeltas()
              await this.sophon.sendEnd({
                messageId,
                sessionId,
                // Only override text if nothing streamed yet. With
                // some accumulated bytes, the server already shows
                // them — ending without `text` keeps the partial
                // visible (truthful "the agent died mid-reply" UX).
                ...(accumulated.length === 0
                  ? { text: formatRunErrorForChat(msg) }
                  : {}),
              })
            })
          },
          onApproval: (ev) => {
            // OpenClaw paused the run pending an approval. Phase=resolved
            // events are informational echoes (the gateway acknowledging
            // a decision we already pushed) — log + drop. For requested
            // we fan out to SAP `approval_requested` so iOS lights up
            // its ApprovalOptionsSheet.
            if (ev.phase !== 'requested') return
            const approvalId = ev.approvalId
            if (!approvalId) {
              this.log(`[bridge] approval.requested missing approvalId — dropping`)
              return
            }
            const action = ev.kind === 'plugin'
              ? 'plugin.invoke'
              : 'shell.exec'
            // OpenClaw used to leave `message` undefined when it had
            // nothing to add; recent versions send `message: ""`. The
            // earlier `??`-fallback let the empty string through,
            // server's zod schema (`message.min(1)`) rejected the
            // POST with HTTP 400, and approvals never reached iOS —
            // sessions hung mid-turn waiting for input that couldn't
            // arrive. Trim+fall-through so the fallback fires on
            // both null/undefined AND empty/whitespace strings.
            const trimmedMsg = ev.message?.trim()
            const messageBody = (trimmedMsg && trimmedMsg.length > 0)
              ? trimmedMsg
              : (ev.command ? `Run \`${ev.command}\`?` : ev.title)
            // Severity mapping is heuristic — OpenClaw doesn't expose
            // a numeric/level severity, just a free-form `status`.
            // Treat unavailable as critical (user can't approve →
            // surface red banner); everything else is medium.
            const severity = ev.status === 'unavailable' ? 'critical' : 'medium'
            enqueue(() => this.sophon.requestApproval({
              sessionId,
              interactionId,
              approvalId,
              approvalSlug: ev.approvalSlug,
              action,
              toolCallId: ev.toolCallId,
              title: ev.title,
              severity,
              command: ev.command,
              host: ev.host,
              message: messageBody,
            }))
          },
          onTool: (ev) => {
            const argsSummary = summarizeArgs(ev.args)
            const statusLabel = ev.phase === 'start'
              ? `${ev.name}${argsSummary ? ` ${argsSummary}` : ''}`
              : undefined
            switch (ev.phase) {
              case 'start':
                enqueue(() => this.sophon.createTask({
                  sessionId,
                  interactionId,
                  taskId: ev.toolCallId,
                  kind: ev.name,
                  statusLabel,
                  args: ev.args,
                }))
                // Side-channel: if this is a file-touching tool, resolve
                // realpath and tell the server. Best-effort and async —
                // we don't queue or await this against the SAP send
                // chain. Failure modes (permission denied, file gone,
                // path missing from args) are silently swallowed inside
                // trackToolFile / notifyToolFile.
                void this.trackToolFile(sessionId, ev.name, ev.args)
                return
              case 'update':
                enqueue(() => this.sophon.updateTask({
                  sessionId,
                  interactionId,
                  taskId: ev.toolCallId,
                  partialResult: ev.partialResult,
                }))
                return
              case 'result': {
                const ok = !ev.isError
                const errString = ev.isError
                  ? (typeof ev.result === 'string'
                      ? ev.result
                      : safeStringify(ev.result))
                  : undefined
                enqueue(() => this.sophon.finishTask({
                  sessionId,
                  interactionId,
                  taskId: ev.toolCallId,
                  name: ev.name,
                  status: ok ? 'completed' : 'failed',
                  ...(errString ? { error: errString } : {}),
                  ...(ok ? { result: ev.result } : {}),
                }))
                return
              }
            }
          },
        },
      })
    } catch (err) {
      // chat.send itself failed — fall back to a synthetic final.
      await this.sophon.sendEnd({
        messageId,
        sessionId,
        text: formatRunErrorForChat(err),
      })
    }
  }

  /**
   * File-tool tracking — resolve the path the agent touched to its
   * canonical realpath and notify Sophon. Used by the iOS file viewer
   * (docs/FILE_VIEWER_PLAN.md): the server's notifyToolFile row is
   * the gate for /v1/me/sessions/:id/file proxy reads.
   *
   * Tool names match `read`/`edit`/`write` case-insensitively; multi-
   * variant Edit tools (MultiEdit, NotebookEdit) are treated as Edit.
   * Glob is intentionally skipped — see plan §2.
   *
   * Best-effort; any error (permission denied, file gone, args parse
   * failure) is swallowed. The downstream notifyToolFile call has the
   * same property — at worst the file simply doesn't show up in the
   * iOS Files tab, the chat itself is unaffected.
   */
  private async trackToolFile(
    sessionId: string,
    toolName: string,
    args: unknown,
  ): Promise<void> {
    const normalized = normalizeFileTool(toolName)
    if (!normalized) return
    const path = parseFilePathFromArgs(args)
    if (!path) return
    let real: string
    try {
      real = await fsp.realpath(path)
    } catch {
      // ENOENT / EACCES / not-yet-created — skip. Tools that create new
      // files (Write) hit this on phase=start; we'd see them again on a
      // subsequent Edit anyway, by which point the file exists.
      return
    }
    let sizeBytes: number | undefined
    try {
      const stat = await fsp.stat(real)
      sizeBytes = stat.size
    } catch {
      // Don't bail — size is optional metadata.
    }
    // E2E: encrypt path + display_name and compute the blind index
    // under the per-session session_key. Skip silently when we don't
    // have a key for this session yet (transient state — a sibling
    // grant should be in flight).
    const sessionKey = this.sessionKeyStore.get(sessionId)
    if (!sessionKey) {
      this.log(`[crypto] trackToolFile skipped: no session_key for ${sessionId}`)
      return
    }
    let pathCt: string
    let displayNameCt: string
    let pathBlindIdx: string
    try {
      const idxKey = deriveBlindIndexKey(sessionKey)
      pathBlindIdx = blindIndex(idxKey, 'agent_files', sessionId, real)
      const blobKey = deriveBlobKey(
        sessionKey,
        `agent_files/${sessionId}/${pathBlindIdx}`,
      )
      pathCt = Buffer.from(
        encryptSymmetric(new TextEncoder().encode(real), blobKey),
      ).toString('base64')
      displayNameCt = Buffer.from(
        encryptSymmetric(new TextEncoder().encode(basename(real)), blobKey),
      ).toString('base64')
    } catch (err) {
      this.log(`[crypto] notifyToolFile encrypt failed: ${(err as Error).message}`)
      return
    }

    await this.sophon.notifyToolFile({
      sessionId,
      tool: normalized,
      pathCt,
      displayNameCt,
      pathBlindIdx,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    })
  }
}

/** Tool-name → canonical {read|edit|write} or null for non-file tools.
 *  Accepts "Edit", "edit", "MultiEdit", "Read", "Write", "NotebookEdit"
 *  etc. — anything from Claude Code's tool surface; OpenClaw passes the
 *  name through verbatim. */
function normalizeFileTool(name: string): 'read' | 'edit' | 'write' | null {
  const lower = name.toLowerCase()
  if (lower === 'read') return 'read'
  if (lower === 'write') return 'write'
  // edit | multiedit | notebookedit | …edit suffix → treat as edit
  if (lower.endsWith('edit')) return 'edit'
  return null
}

/** Pull a filesystem path out of an opaque tool args object. iOS'
 *  EditToolView uses the same key fallback chain (`file_path` →
 *  `path` → `file`); we mirror it so what the user sees in the chat
 *  card matches what we record in session_agent_files. */
function parseFilePathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  for (const key of ['file_path', 'path', 'file']) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** Pull the libuv errno tag (`ENOENT`, `EACCES`, …) off a thrown
 *  fs error. Node's NodeJS.ErrnoException type isn't reachable
 *  through `unknown` narrowing, so we duck-type. */
function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/** Best-effort MIME detection. Pure extension lookup for the common
 *  text/code/image set the viewer cares about; falls back to a tiny
 *  magic-byte sniff for image binaries that may have lost extension,
 *  then `application/octet-stream`. We deliberately don't pull in
 *  `file-type` — its install footprint is meaningful and the viewer
 *  only needs three buckets (text vs image vs binary). */
function detectMime(path: string, buf: Buffer): string {
  const ext = extname(path).toLowerCase()
  const fromExt = MIME_BY_EXT[ext]
  if (fromExt) return fromExt
  if (buf.length >= 4) {
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    // GIF: 47 49 46 38
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
    // WebP: starts with "RIFF" then "WEBP" at offset 8
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp'
    }
  }
  // UTF-8 text heuristic: if every byte is either ASCII printable,
  // newline/tab/CR, or part of a valid UTF-8 sequence, treat as text.
  // Sample up to 4 KB to keep the check cheap on a 1.5 MB read.
  const sample = buf.slice(0, Math.min(buf.length, 4096))
  if (looksLikeText(sample)) return 'text/plain'
  return 'application/octet-stream'
}

/** True if every byte in `buf` is plausibly UTF-8 text. Rejects
 *  buffers containing NUL or non-printable control bytes outside
 *  whitespace. The magic constants here mirror what most editors
 *  use for "binary detection". */
function looksLikeText(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0) return false
    if (b === undefined) return false
    if (b < 0x09) return false                                    // control
    if (b > 0x0d && b < 0x20) return false                         // control
    // High bytes are fine; they're either UTF-8 continuation or BOM.
  }
  return true
}

const MIME_BY_EXT: Record<string, string> = {
  // text / code
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.swift': 'text/x-swift',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.env': 'text/plain',
  '.log': 'text/plain',
  '.lock': 'text/plain',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
  // images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
}

/**
 * Build a short status_label like `bash {cmd: "ls -la /tmp"}` so iOS'
 * ToolGroupView has something readable while the tool is in flight.
 * Heuristic: pick the first 1–2 likely-meaningful keys from the args
 * object and clamp.
 */
function summarizeArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const obj = args as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 0) return undefined
  const preferred = keys.find((k) =>
    /^(command|cmd|path|file|file_path|url|query|input)$/i.test(k),
  ) ?? keys[0]
  if (preferred === undefined) return undefined
  const value = obj[preferred]
  const valueStr = typeof value === 'string'
    ? value
    : safeStringify(value)
  if (!valueStr) return undefined
  return `${preferred}=${valueStr.length > 60 ? valueStr.slice(0, 57) + '…' : valueStr}`
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') return v
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}
