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

import { deriveBlobKey, encryptSymmetric } from './crypto.js'

/** Bridge package version. Track package.json — server captures this
 *  via the post-open `hello` frame and stores it on installations.row
 *  so iOS can gate viewer affordances by capability (file viewer
 *  requires >= 0.6.0; e2e message-text in 0.7.0; tasks + approvals
 *  e2e in 0.8.0; Phase 4b cutover — plaintext-write paths removed —
 *  in 0.9.0). */
const BRIDGE_VERSION = '0.9.0'

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
  /** 32-byte e2e install key from credentials.json. When set, the
   *  client encrypts outbound wire fields (message text, tool args,
   *  file paths) per docs/ENCRYPTION_PLAN.md §3. Phase 3.1 just
   *  threads the key through; field-by-field wiring follows in
   *  later phases. */
  installKey?: Uint8Array
}

export class SophonClient {
  private opts: SophonClientOpts
  private ws: WebSocket | null = null
  private reconnectMs = 1000
  private readonly maxReconnectMs = 30_000
  private stopped = false
  private updateHandler: ((u: SophonUpdate) => Promise<void>) | null = null
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
  /** When non-null, the client encrypts wire fields. Visible to
   *  outbound RPC methods so each can decide whether to wrap in
   *  ciphertext or pass through as plaintext (legacy mode). */
  protected installKey: Uint8Array | null

  constructor(opts: SophonClientOpts) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.onConnected = opts.onConnected
    this.installKey = opts.installKey ?? null
  }

  /** True iff this client has an install_key and will encrypt wire
   *  fields. Bridge code branches on this to decide whether new
   *  ciphertext fields go on the request or stay legacy plaintext. */
  hasInstallKey(): boolean {
    return this.installKey !== null
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

  /** Per-session blob_key for messages. Each session gets its own
   *  AES key derived from install_key + HKDF info
   *  `messages/<session_id>`. Per-session (not per-message) because
   *  deltas accumulate to the same logical bubble and the bridge
   *  doesn't know `message_id` before calling
   *  `startStreamingMessage`. iOS uses the same path on read. Throws
   *  when there's no install_key — post-cutover the bridge MUST be
   *  paired e2e to send anything. */
  protected messagesBlobKey(sessionId: string): Uint8Array {
    if (!this.installKey) {
      throw new Error('install_key required: bridge must be re-paired (Phase 4b cutover)')
    }
    return deriveBlobKey(this.installKey, `messages/${sessionId}`)
  }

  /** AES-GCM-encrypt UTF-8 text under the per-session messages
   *  blob_key. Returns base64 of the versioned envelope. Throws when
   *  install_key is missing. */
  protected encryptMessageText(sessionId: string, text: string): string {
    const key = this.messagesBlobKey(sessionId)
    const env = encryptSymmetric(new TextEncoder().encode(text), key)
    return Buffer.from(env).toString('base64')
  }

  /** Per-session blob_key for tasks. Same shape as
   *  `messagesBlobKey` — fine-grained per-task derivation isn't
   *  worth the complexity for v1 since tasks are read in batches
   *  anyway. Throws when no install_key. */
  protected tasksBlobKey(sessionId: string): Uint8Array {
    if (!this.installKey) {
      throw new Error('install_key required: bridge must be re-paired (Phase 4b cutover)')
    }
    return deriveBlobKey(this.installKey, `tasks/${sessionId}`)
  }

  /** Encrypt an arbitrary JSON-shaped value (input/partial_result/
   *  result) under the tasks blob_key. The plaintext is the
   *  JSON-stringified payload; iOS parses on decrypt. */
  protected encryptTaskJson(sessionId: string, value: unknown): string {
    const key = this.tasksBlobKey(sessionId)
    const json = JSON.stringify(value ?? null)
    const env = encryptSymmetric(new TextEncoder().encode(json), key)
    return Buffer.from(env).toString('base64')
  }

  /** Encrypt a small text field (status_label / error) under the
   *  tasks blob_key. */
  protected encryptTaskText(sessionId: string, text: string): string {
    const key = this.tasksBlobKey(sessionId)
    const env = encryptSymmetric(new TextEncoder().encode(text), key)
    return Buffer.from(env).toString('base64')
  }

  /** Atomic non-streaming reply. */
  async sendMessage(input: {
    sessionId: string
    text: string
    interactionId?: string | null
  }): Promise<{ messageId: string }> {
    const data = await this.post('/v1/bridge/sendMessage', {
      session_id: input.sessionId,
      text_ct: this.encryptMessageText(input.sessionId, input.text),
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
    const data = await this.post('/v1/bridge/sendMessage', {
      session_id: input.sessionId,
      text_ct: this.encryptMessageText(input.sessionId, ''),
      idempotency_key: randomUUID(),
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
    })
    const result = (data.result ?? {}) as { message_id?: string }
    return { messageId: result.message_id ?? '' }
  }

  /** Append a streaming chunk. The delta is independently encrypted
   *  under the same session blob_key — server forwards over SSE
   *  without ever touching plaintext. iOS decrypts each delta as it
   *  arrives and appends to the bubble. */
  async sendDelta(input: {
    messageId: string
    sessionId: string
    delta: string
  }): Promise<void> {
    await this.post('/v1/bridge/sendMessageDelta', {
      message_id: input.messageId,
      delta_ct: this.encryptMessageText(input.sessionId, input.delta),
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
      ? this.encryptMessageText(input.sessionId, input.text)
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
    // E2E: encrypt content-bearing fields (status_label, args) under
    // the per-session tasks blob_key. `kind` stays plaintext — it's
    // a tool-name enum (Read/Edit/Bash/...) used by the iOS deck for
    // icon/color routing and is not user content.
    await this.post('/v1/bridge/createTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      kind: input.kind,
      ...(input.statusLabel
        ? { status_label_ct: this.encryptTaskText(input.sessionId, input.statusLabel) }
        : {}),
      ...(input.args !== undefined
        ? { args_ct: this.encryptTaskJson(input.sessionId, input.args) }
        : {}),
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
    await this.post('/v1/bridge/updateTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      ...(input.statusLabel
        ? { status_label_ct: this.encryptTaskText(input.sessionId, input.statusLabel) }
        : {}),
      ...(input.progressPercent !== undefined ? { progress_percent: input.progressPercent } : {}),
      ...(input.partialResult !== undefined
        ? { partial_result_ct: this.encryptTaskJson(input.sessionId, input.partialResult) }
        : {}),
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
    await this.post('/v1/bridge/finishTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      ...(input.name ? { name: input.name } : {}),
      status: input.status,
      ...(input.statusLabel
        ? { status_label_ct: this.encryptTaskText(input.sessionId, input.statusLabel) }
        : {}),
      ...(input.error
        ? { error_ct: this.encryptTaskText(input.sessionId, input.error) }
        : {}),
      ...(input.result !== undefined
        ? { result_ct: this.encryptTaskJson(input.sessionId, input.result) }
        : {}),
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
    // Encrypt the full details payload under per-session approvals
    // blob_key. iOS decrypts on the SSE event. Throws when no
    // install_key (post-cutover the bridge MUST be e2e).
    if (!this.installKey) {
      throw new Error('install_key required: bridge must be re-paired (Phase 4b cutover)')
    }
    const blobKey = deriveBlobKey(this.installKey, `approvals/${input.sessionId}`)
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
