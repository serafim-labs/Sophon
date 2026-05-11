/**
 * Sophon-side WebSocket client. Connects to wss://api.sophon.at/v1/bridge/ws
 * with the agent's bot token, drains updates, and exposes:
 *   - onUpdate(handler) — fires for each agent update from Sophon
 *   - sendMessage / sendMessageDelta / sendMessageEnd — REST POSTs back
 *   - ack(updateId) — confirms delivery so the queue drains
 *
 * Reconnect with expo backoff. The watcher on the server side replays
 * unack'd updates, so we don't need our own offset persistence —
 * we just ack as we go.
 */

import { WebSocket } from 'ws'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveBlobKey, encryptSymmetric } from './crypto.js'
import type { SessionKeyStore } from './session-keys.js'

/** Bridge package version reported in the hello-frame and persisted to
 *  `installations.bridge_version`. Read from package.json so a forgotten
 *  manual bump can't drift from the published version (caught us once on
 *  0.13.0 where this was hard-coded to '0.12.0'). */
const BRIDGE_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

export interface SophonUpdate {
  update_id: string
  type: string
  payload: Record<string, unknown>
  interaction_id: string | null
  session_id: string | null
  installation_id: string | null
  created_at: string
}

export interface SophonClientOpts {
  baseUrl: string // e.g. https://api.sophon.at
  botToken: string
  log?: (line: string) => void
  /** Fires once per WS open. Use it to print a `[ready]` sentinel or
   *  flip a "we're talking to Sophon" indicator. Called for every
   *  reconnect, not just the first — caller dedupes if needed. */
  onConnected?: () => void
  /** Per-session symmetric key store. Bridge generates session_keys
   *  for sessions it owns, accepts grants from siblings, and
   *  fans-out wraps when new devices join. */
  sessionKeyStore: SessionKeyStore
}

export class SophonClient {
  private opts: SophonClientOpts
  private ws: WebSocket | null = null
  private reconnectMs = 1000
  private readonly maxReconnectMs = 30_000
  private stopped = false
  private updateHandler: ((u: SophonUpdate) => Promise<void>) | null = null
  /** update_id dedupe ring. The cloud fans every `session.message` to
   *  one WS subscription per bridge connection — but zombie subscriptions
   *  (from a prior process that crashed or was kickstarted before its
   *  ws.close propagated to the server) can leave 2+ listeners on the
   *  same installation, causing duplicate handler runs. The reconnect
   *  loop also replays unack'd updates, which we ACK immediately on
   *  receipt — but a race between ack and replay can briefly double up.
   *  Either way, idempotent processing here is cheaper than chasing the
   *  cloud-side fanout state machine. */
  private seenUpdateIds = new Set<string>()
  private static readonly SEEN_UPDATE_CAP = 1024
  /** Server → bridge RPC handler. Any frame with `req_id` (other than
   *  the well-known envelope types like `update`/`ping`/`pong`) is
   *  dispatched here. The handler returns the reply payload; the
   *  envelope (`req_id`, `type=<X>.resp`) is added by the message
   *  loop. Used by the file viewer (`file.read.req`). */
  private requestHandler:
    | ((frame: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | null = null
  private log: (line: string) => void
  private onConnected?: () => void
  protected sessionKeyStore: SessionKeyStore

  constructor(opts: SophonClientOpts) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.onConnected = opts.onConnected
    this.sessionKeyStore = opts.sessionKeyStore
  }

  onUpdate(handler: (u: SophonUpdate) => Promise<void>): void {
    this.updateHandler = handler
  }

  /** Register a handler for server → bridge RPCs. The frame argument
   *  has the full request including `type` and `req_id`; the resolved
   *  payload becomes the reply (envelope added automatically). */
  onRequest(
    handler: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): void {
    this.requestHandler = handler
  }

  async start(): Promise<void> {
    void this.connectLoop()
  }

  stop(): void {
    this.stopped = true
    this.ws?.close()
    this.ws = null
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce()
        this.reconnectMs = 1000 // reset on clean exit
      } catch (err) {
        this.log(`[sophon] disconnected: ${(err as Error).message}`)
      }
      if (this.stopped) break
      const jitter = Math.floor(Math.random() * 250)
      const wait = Math.min(this.reconnectMs + jitter, this.maxReconnectMs)
      this.log(`[sophon] reconnecting in ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
      this.reconnectMs = Math.min(Math.floor(this.reconnectMs * 1.8), this.maxReconnectMs)
    }
  }

  private async runOnce(): Promise<void> {
    const wsUrl = this.opts.baseUrl.replace(/^http/, 'ws') + '/v1/bridge/ws'
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.opts.botToken}` },
    })
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    this.log('[sophon] connected')
    // Announce our version to the server so it can stamp
    // installations.bridge_version. Sent before any other frame.
    // Server treats unknown frame types as a no-op (forward-compat),
    // so older servers safely ignore this.
    try {
      ws.send(JSON.stringify({ type: 'hello', version: BRIDGE_VERSION }))
    } catch {
      // If the very first send fails the close path will fire and
      // reconnect — don't surface here.
    }
    try {
      this.onConnected?.()
    } catch {
      // never let a misbehaving consumer kill the WS lifecycle
    }

    return new Promise<void>((resolve, reject) => {
      // Two-pronged liveness watchdog:
      //
      //  (a) **Inbound-byte gap**: server pings every 25s + update frames
      //      during traffic. If we go 30s without ANY inbound message,
      //      the socket is wedged on a half-broken connection (Wi-Fi
      //      flap, NAT timeout, server restart). The `close`/`error`
      //      events don't fire in this state; we have to terminate
      //      ourselves so the close handler kicks reconnect.
      //
      //  (b) **Time-jump (laptop wake-from-sleep)**: when the lid was
      //      closed, the WS died on the server side, but the local TCP
      //      socket sits frozen — no event fires. We detect "tick took
      //      way longer than its interval" as a sleep signal and
      //      reconnect immediately. Without this, every wake meant
      //      ~30s of "iOS shows offline" before (a) caught it.
      let lastInbound = Date.now()
      let lastTick = Date.now()
      const TICK_MS = 5_000
      const SLEEP_THRESHOLD_MS = 12_000   // tick gap > 12s ≈ machine slept
      const IDLE_THRESHOLD_MS = 30_000    // 30s of silence ≈ zombie WS
      const watchdog = setInterval(() => {
        const now = Date.now()
        const tickGap = now - lastTick
        lastTick = now
        if (tickGap > SLEEP_THRESHOLD_MS) {
          this.log(`[sophon] wake detected (tick gap ${Math.round(tickGap / 1000)}s) — terminating`)
          clearInterval(watchdog)
          try { ws.terminate() } catch { /* noop */ }
          return
        }
        const idleMs = now - lastInbound
        if (idleMs > IDLE_THRESHOLD_MS) {
          this.log(`[sophon] no inbound for ${Math.round(idleMs / 1000)}s — terminating`)
          clearInterval(watchdog)
          try { ws.terminate() } catch { /* noop */ }
        }
      }, TICK_MS)

      ws.on('message', (raw) => {
        lastInbound = Date.now()
        let frame: Record<string, unknown> = {}
        try {
          frame = JSON.parse(raw.toString('utf8'))
        } catch {
          return
        }
        const type = String(frame.type ?? '')
        if (type === 'ready') return
        if (type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }
        if (type === 'pong') return
        // Server → bridge RPC. Anything with a `req_id` that isn't an
        // envelope frame above is a request the SAP wants us to fulfil
        // (file viewer reads, future capability probes). Dispatch to
        // the registered handler async — large file reads can take
        // hundreds of ms; we don't want to block the inbound loop.
        if (typeof frame.req_id === 'string' && this.requestHandler) {
          const reqId = frame.req_id
          const replyType = type ? `${type.replace(/\.req$/, '')}.resp` : 'rpc.resp'
          ;(async () => {
            let reply: Record<string, unknown>
            try {
              reply = await this.requestHandler!(frame)
            } catch (err) {
              reply = {
                error: { code: 'handler_failed', message: (err as Error).message },
              }
            }
            try {
              ws.send(JSON.stringify({ ...reply, type: replyType, req_id: reqId }))
            } catch (err) {
              this.log(`[sophon] reply send failed: ${(err as Error).message}`)
            }
          })()
          return
        }
        if (type === 'update') {
          const update = frame.update as SophonUpdate | undefined
          if (!update) return
          // ACK on receipt (not after handler completes). The watcher
          // on the server side re-sends unack'd rows every ~5 s, which
          // would otherwise duplicate slow handlers (a streaming LLM
          // can take 30 s+). Trade: if we ACK then crash before the
          // handler finishes, the work is lost — but we've already
          // started; partial progress is in Sophon (sendMessage
          // placeholder, possibly some deltas). On reconnect the agent
          // skips the un-replayed update.
          ws.send(JSON.stringify({ type: 'ack', up_to_update_id: update.update_id }))
          // Dedupe by update_id. Two paths can fan the same update twice:
          // (1) zombie subscriptions on the cloud — a prior bridge ws
          //     conn that didn't fully close left its listener attached,
          //     so the fanout writes to two listeners on the same install.
          // (2) reconnect-replay race — we ACK on receipt, but if reconnect
          //     fires before the ack lands, the watcher replays the row.
          // Either way, double-handling produces a "[OpenClaw error] not
          // connected" bubble alongside the real reply, because handler #2
          // races handler #1's chat.send and one of them loses on the WS.
          if (update.update_id) {
            if (this.seenUpdateIds.has(update.update_id)) {
              this.log(`[sophon] duplicate update ${update.update_id} type=${update.type} — dropped`)
              return
            }
            this.seenUpdateIds.add(update.update_id)
            // Bound the set; oldest entries fall off naturally on overflow
            // (rough FIFO: Sets iterate in insertion order).
            if (this.seenUpdateIds.size > SophonClient.SEEN_UPDATE_CAP) {
              const first = this.seenUpdateIds.values().next().value
              if (first !== undefined) this.seenUpdateIds.delete(first)
            }
          }
          ;(async () => {
            try {
              if (this.updateHandler) await this.updateHandler(update)
            } catch (err) {
              this.log(`[sophon] handler failed: ${(err as Error).message}`)
            }
          })()
        }
      })
      ws.on('close', () => {
        clearInterval(watchdog)
        resolve()
      })
      ws.on('error', (err) => {
        clearInterval(watchdog)
        reject(err)
      })
    })
  }

  // ─── REST helpers ─────────────────────────────────────────────────

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const r = await fetch(this.opts.baseUrl + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || !(data as { ok?: boolean }).ok) {
      throw new Error(`POST ${path} → ${r.status}: ${JSON.stringify(data)}`)
    }
    return data as Record<string, unknown>
  }

  /** Per-session blob_key for messages. Derived from this session's
   *  `session_key` (held in `SessionKeyStore`) + HKDF info
   *  `messages/<session_id>`. iOS uses the same path on read.
   *  Auto-creates a fresh session_key for sessions the bridge owns
   *  but hasn't seen yet (cron-driven runs, /clear that rotates).
   *  Caller is responsible for fanning the new key out via
   *  POST /v1/bridge/sessions/:id/recipients before downstream reads. */
  protected async messagesBlobKey(sessionId: string): Promise<Uint8Array> {
    const sessionKey = await this.sessionKeyStore.getOrCreate(sessionId)
    return deriveBlobKey(sessionKey, `messages/${sessionId}`)
  }

  /** AES-GCM-encrypt UTF-8 text under the per-session messages
   *  blob_key. Returns base64 of the versioned envelope. */
  protected async encryptMessageText(sessionId: string, text: string): Promise<string> {
    const key = await this.messagesBlobKey(sessionId)
    const env = encryptSymmetric(new TextEncoder().encode(text), key)
    return Buffer.from(env).toString('base64')
  }

  /** Per-session blob_key for tasks. Same shape as `messagesBlobKey`. */
  protected async tasksBlobKey(sessionId: string): Promise<Uint8Array> {
    const sessionKey = await this.sessionKeyStore.getOrCreate(sessionId)
    return deriveBlobKey(sessionKey, `tasks/${sessionId}`)
  }

  /** Encrypt an arbitrary JSON-shaped value under the tasks blob_key. */
  protected async encryptTaskJson(sessionId: string, value: unknown): Promise<string> {
    const key = await this.tasksBlobKey(sessionId)
    const json = JSON.stringify(value ?? null)
    const env = encryptSymmetric(new TextEncoder().encode(json), key)
    return Buffer.from(env).toString('base64')
  }

  /** Encrypt a small text field (status_label / error) under tasks blob_key. */
  protected async encryptTaskText(sessionId: string, text: string): Promise<string> {
    const key = await this.tasksBlobKey(sessionId)
    const env = encryptSymmetric(new TextEncoder().encode(text), key)
    return Buffer.from(env).toString('base64')
  }

  /** Register or refresh this bridge's `devices` row on the server.
   *  Called on every connect; idempotent server-side. The pubkey
   *  becomes the long-term identity siblings encrypt session_keys
   *  for. Returns the assigned device_id. */
  async registerBridgeDevice(input: {
    pubkeyHex: string
    label?: string
  }): Promise<{ deviceId: string; pubkeyChanged: boolean }> {
    const data = await this.post('/v1/bridge/devices', {
      pubkey: input.pubkeyHex,
      ...(input.label ? { label: input.label } : {}),
    })
    const result = (data as { result?: { device_id: string; pubkey_changed?: boolean } }).result
    if (!result || !result.device_id) {
      throw new Error('register bridge device: missing device_id in response')
    }
    return {
      deviceId: result.device_id,
      pubkeyChanged: Boolean(result.pubkey_changed),
    }
  }

  /** Bulk-grant wrapped session_keys to one or more recipient devices
   *  for a session this bridge owns. Caller has already done the
   *  sealed-box wrap under each device's pubkey; this is a thin
   *  HTTP shim. */
  async postBridgeSessionRecipients(input: {
    sessionId: string
    recipients: Array<{ deviceId: string; wrappedSessionKeyB64: string }>
    wrappedByDeviceId?: string
  }): Promise<void> {
    await this.post(`/v1/bridge/sessions/${input.sessionId}/recipients`, {
      recipients: input.recipients.map((r) => ({
        device_id: r.deviceId,
        wrapped_session_key: r.wrappedSessionKeyB64,
      })),
      ...(input.wrappedByDeviceId ? { wrapped_by_device_id: input.wrappedByDeviceId } : {}),
    })
  }

  /** Spawn a new chat session owned by THIS bridge installation.
   *
   *  Used for cron-initiated runs: OpenClaw fires the routine on its
   *  own schedule, with no user-side interaction beforehand, so the
   *  bridge needs to mint a Sophon session on demand to host the
   *  transcript + approvals. iOS sees the new session via the
   *  `session_created` SSE event the same way it does for chats the
   *  user creates.
   *
   *  The title (when given) is encrypted under the per-session blob_key
   *  derived against the new session_id — same path iOS uses for
   *  title decoding (`session_meta/<session_id>`).
   */
  async createSession(input: {
    title?: string
    source?: string
  }): Promise<{ sessionId: string }> {
    // Mint id locally so we can encrypt the title against it before
    // POST. Server ignores anything we send beyond title_ct + source.
    const data = await this.post('/v1/bridge/createSession', {
      ...(input.source ? { source: input.source } : {}),
      // Title encryption requires knowing the session id ahead of time;
      // the server-side endpoint mints its own id, so we either accept a
      // round-trip without a title or skip the title for the very first
      // call. We keep it simple: omit title_ct on the create, optionally
      // PATCH-rename later (out of scope for v1 — display falls back to
      // the routine name in iOS routine surfaces).
    })
    const result = (data.result ?? {}) as { session_id?: string }
    if (!result.session_id) throw new Error('createSession returned no session_id')
    return { sessionId: result.session_id }
  }

  /** Atomic non-streaming reply. */
  async sendMessage(input: {
    sessionId: string
    text: string
    interactionId?: string | null
  }): Promise<{ messageId: string }> {
    const textCt = await this.encryptMessageText(input.sessionId, input.text)
    const data = await this.post('/v1/bridge/sendMessage', {
      session_id: input.sessionId,
      text_ct: textCt,
      idempotency_key: randomUUID(),
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
    })
    const result = (data.result ?? {}) as { message_id?: string }
    return { messageId: result.message_id ?? '' }
  }

  /** Streaming start — open the row with an empty-string envelope so
   *  iOS gets a placeholder bubble immediately. Deltas append to it
   *  in-memory; sendMessageEnd replaces with the canonical full text. */
  async startStreamingMessage(input: {
    sessionId: string
    interactionId?: string | null
  }): Promise<{ messageId: string }> {
    const textCt = await this.encryptMessageText(input.sessionId, '')
    const data = await this.post('/v1/bridge/sendMessage', {
      session_id: input.sessionId,
      text_ct: textCt,
      idempotency_key: randomUUID(),
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
    })
    const result = (data.result ?? {}) as { message_id?: string }
    return { messageId: result.message_id ?? '' }
  }

  /** Append a streaming chunk. */
  async sendDelta(input: {
    messageId: string
    sessionId: string
    delta: string
  }): Promise<void> {
    const deltaCt = await this.encryptMessageText(input.sessionId, input.delta)
    await this.post('/v1/bridge/sendMessageDelta', {
      message_id: input.messageId,
      delta_ct: deltaCt,
      idempotency_key: randomUUID(),
    })
  }

  async sendEnd(input: {
    messageId: string
    sessionId: string
    text?: string
    usage?: Record<string, unknown>
  }): Promise<void> {
    const textCt = input.text !== undefined
      ? await this.encryptMessageText(input.sessionId, input.text)
      : null
    await this.post('/v1/bridge/sendMessageEnd', {
      message_id: input.messageId,
      ...(textCt ? { text_ct: textCt } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      idempotency_key: randomUUID(),
    })
  }

  // ─── Tool surface — fans out OpenClaw's `stream:"tool"` frames as
  //     SAP task_* events. iOS' tasksBySession + ToolGroupView already
  //     consume these; the bridge just has to relay them.

  async createTask(input: {
    sessionId: string
    interactionId?: string | null
    taskId: string
    kind: string
    statusLabel?: string
    args?: unknown
  }): Promise<void> {
    const statusLabelCt = input.statusLabel !== undefined
      ? await this.encryptTaskText(input.sessionId, input.statusLabel)
      : null
    const argsCt = input.args !== undefined
      ? await this.encryptTaskJson(input.sessionId, input.args)
      : null
    await this.post('/v1/bridge/createTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      kind: input.kind,
      ...(statusLabelCt ? { status_label_ct: statusLabelCt } : {}),
      ...(argsCt ? { args_ct: argsCt } : {}),
      idempotency_key: `task:create:${input.taskId}`,
    })
  }

  async updateTask(input: {
    sessionId: string
    interactionId?: string | null
    taskId: string
    statusLabel?: string
    progressPercent?: number
    partialResult?: unknown
  }): Promise<void> {
    const statusLabelCt = input.statusLabel !== undefined
      ? await this.encryptTaskText(input.sessionId, input.statusLabel)
      : null
    const partialResultCt = input.partialResult !== undefined
      ? await this.encryptTaskJson(input.sessionId, input.partialResult)
      : null
    await this.post('/v1/bridge/updateTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      ...(statusLabelCt ? { status_label_ct: statusLabelCt } : {}),
      ...(input.progressPercent !== undefined ? { progress_percent: input.progressPercent } : {}),
      ...(partialResultCt ? { partial_result_ct: partialResultCt } : {}),
      idempotency_key: `task:update:${input.taskId}:${randomUUID()}`,
    })
  }

  async finishTask(input: {
    sessionId: string
    interactionId?: string | null
    taskId: string
    name?: string
    status: 'completed' | 'failed' | 'cancelled'
    statusLabel?: string
    error?: string
    result?: unknown
  }): Promise<void> {
    const statusLabelCt = input.statusLabel !== undefined
      ? await this.encryptTaskText(input.sessionId, input.statusLabel)
      : null
    const errorCt = input.error !== undefined
      ? await this.encryptTaskText(input.sessionId, input.error)
      : null
    const resultCt = input.result !== undefined
      ? await this.encryptTaskJson(input.sessionId, input.result)
      : null
    await this.post('/v1/bridge/finishTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      ...(input.name ? { name: input.name } : {}),
      status: input.status,
      ...(statusLabelCt ? { status_label_ct: statusLabelCt } : {}),
      ...(errorCt ? { error_ct: errorCt } : {}),
      ...(resultCt ? { result_ct: resultCt } : {}),
      idempotency_key: `task:finish:${input.taskId}:${input.status}`,
    })
  }

  // ─── Tool-touched files — populates session_agent_files on the
  //     server so iOS can list "files modified in this chat" and gate
  //     /file proxy reads on a session-scoped whitelist.
  //
  //     Best-effort: a notify failure just means iOS won't see the file
  //     in the list (and /file would return 403). The tool-call itself
  //     already streams via createTask/finishTask — losing the notify
  //     is at most a UX regression, not a functional one. Log + swallow.

  /**
   * Records a file the agent touched. `pathCt` / `displayNameCt` are
   * AES-GCM envelopes under the per-install path-derived blob_key;
   * `pathBlindIdx` is the HMAC server lookup key. Computed by
   * bridge.ts trackToolFile. Post Phase 4b cutover all three are
   * required (the row PK is `(session_id, path_blind_idx)` and the
   * server has no plaintext path column anymore).
   */
  async notifyToolFile(input: {
    sessionId: string
    tool: 'read' | 'edit' | 'write'
    sizeBytes?: number
    mime?: string
    /** AES-GCM ciphertext envelope (base64) of the realpath. */
    pathCt: string
    /** AES-GCM ciphertext envelope (base64) of the basename. */
    displayNameCt: string
    /** HMAC blind-index (base64url, 22 chars). */
    pathBlindIdx: string
  }): Promise<void> {
    try {
      await this.post('/v1/bridge/notifyToolFile', {
        session_id: input.sessionId,
        tool: input.tool,
        ...(input.sizeBytes !== undefined ? { size_bytes: input.sizeBytes } : {}),
        ...(input.mime ? { mime: input.mime } : {}),
        path_ct: input.pathCt,
        display_name_ct: input.displayNameCt,
        path_blind_idx: input.pathBlindIdx,
      })
    } catch (err) {
      this.log(`[sophon] notifyToolFile failed: ${(err as Error).message}`)
    }
  }

  // ─── Approval surface — fans OpenClaw `stream:"approval"` to SAP
  //     approval_requested. Resolution comes back via bridge-bus
  //     subscription on the WS connection (handled in bridge.ts).

  async requestApproval(input: {
    sessionId: string
    interactionId?: string | null
    approvalId: string
    approvalSlug?: string
    action: string
    toolCallId?: string
    title: string
    severity?: 'low' | 'medium' | 'high' | 'critical'
    command?: string
    host?: string
    message: string
  }): Promise<void> {
    // Encrypt the full details payload under the per-session approvals
    // blob_key, derived from this session's session_key.
    const sessionKey = await this.sessionKeyStore.getOrCreate(input.sessionId)
    const blobKey = deriveBlobKey(sessionKey, `approvals/${input.sessionId}`)
    const details = {
      title: input.title,
      message: input.message,
      command: input.command,
      host: input.host,
      tool_call_id: input.toolCallId,
      approval_slug: input.approvalSlug,
    }
    const env = encryptSymmetric(
      new TextEncoder().encode(JSON.stringify(details)),
      blobKey,
    )
    const detailsCt = Buffer.from(env).toString('base64')
    await this.post('/v1/bridge/requestApproval', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      approval_id: input.approvalId,
      action: input.action,
      severity: input.severity ?? 'medium',
      details_ct: detailsCt,
      idempotency_key: randomUUID(),
    })
  }
}
