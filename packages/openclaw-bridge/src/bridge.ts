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
   * 32-byte e2e install key from credentials.json. When set, every
   * outbound payload that goes through `notifyToolFile`,
   * `createTask`/`finishTask`, and `sendMessage*` gets encrypted
   * before leaving this process — the server stores ciphertext and
   * iOS decrypts on read. When unset (legacy bridge / pre-pairing
   * upgrade), the bridge runs in plaintext mode same as v0.6.x.
   * See docs/ENCRYPTION_PLAN.md §3 for which fields participate.
   */
  installKey?: Uint8Array
}

export class Bridge {
  private sophon: SophonClient
  private openclaw: OpenClawClient
  private log: (line: string) => void
  private debugStream: boolean
  /** When non-null, all wire payloads are end-to-end encrypted. Wired
   *  through `trackToolFile` (Phase 3.4 onwards). */
  private installKey: Uint8Array | null

  constructor(opts: BridgeOpts) {
    this.sophon = opts.sophon
    this.openclaw = opts.openclaw
    this.log = opts.log ?? (() => {})
    this.debugStream = opts.debugStream ?? false
    this.installKey = opts.installKey ?? null
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
    return { error: { code: 'unknown_request', type } }
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
      // E2E mode. install_key is non-optional here.
      if (!this.installKey) {
        // Bridge has no install_key but server forwarded an e2e
        // request. Mismatch shouldn't happen if iOS only sends
        // blind_idx when it has a key, but be defensive.
        return { error: { code: 'no_install_key' } }
      }
      try {
        blobKey = deriveBlobKey(
          this.installKey,
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
      case 'approval.resolved':
        await this.handleApprovalResolved(u)
        return
      case 'installation.created':
      case 'installation.revoked':
        return
      default:
        this.log(`[bridge] ignoring update type ${u.type}`)
    }
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

  private async handleSessionMessage(u: SophonUpdate): Promise<void> {
    const payload = u.payload as {
      session?: { id?: string }
      message?: {
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
    // E2E mode: server-blind iOS encrypted the user's text. Decrypt
    // with the per-session messages blob_key derived from install_key.
    // OpenClaw expects plaintext; the bridge is the trust boundary.
    let text = payload.message?.text ?? ''
    const textCt = payload.message?.text_ct
    if (textCt && this.installKey) {
      try {
        const blobKey = deriveBlobKey(this.installKey, `messages/${sessionId}`)
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
            // Skip `text` if we streamed anything — server already
            // has the full accumulated text. Sending it again would
            // overwrite with `final.text`, which sometimes carries
            // whitespace-normalised wording from the LLM and looks
            // like a flicker. Only fall back to `final.text` when no
            // deltas streamed at all (rare; tool-only turns).
            const fallbackText = accumulated.length === 0
              ? (final.text || '')
              : undefined
            this.dbg(`onFinal triggered deltaCount=${deltaCount} acc=${accumulated.length} finalTextLen=${(final.text ?? '').length} fallback=${fallbackText !== undefined ? 'yes' : 'no'} +${Date.now() - turnStartedAt}ms`)
            enqueue(async () => {
              this.dbg(`sendEnd START drainStart=${Date.now() - turnStartedAt}ms`)
              await drainDeltas()
              const t0 = Date.now()
              await this.sophon.sendEnd({
                messageId,
                sessionId,
                ...(fallbackText !== undefined ? { text: fallbackText } : {}),
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
                  ? { text: `[OpenClaw error] ${msg}` }
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
        text: `[OpenClaw error] ${(err as Error).message}`,
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
    // E2E: encrypt path + display_name and compute the blind index.
    // Required post Phase 4b — server has no plaintext columns. Skip
    // the file silently when there's no install_key (un-paired bridge
    // — shouldn't happen since installation_id is also required for
    // any of this, but defensive).
    if (!this.installKey) {
      this.log(`[crypto] trackToolFile skipped: bridge has no install_key`)
      return
    }
    let pathCt: string
    let displayNameCt: string
    let pathBlindIdx: string
    try {
      // Compute the blind index FIRST — it's part of the per-row
      // blob_key derivation path (so each row gets its own AES key
      // even within the same installation).
      const idxKey = deriveBlindIndexKey(this.installKey)
      pathBlindIdx = blindIndex(idxKey, 'agent_files', sessionId, real)
      const blobKey = deriveBlobKey(
        this.installKey,
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
