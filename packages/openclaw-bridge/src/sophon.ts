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
import { randomUUID } from 'node:crypto'

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
}

export class SophonClient {
  private opts: SophonClientOpts
  private ws: WebSocket | null = null
  private reconnectMs = 1000
  private readonly maxReconnectMs = 30_000
  private stopped = false
  private updateHandler: ((u: SophonUpdate) => Promise<void>) | null = null
  private log: (line: string) => void

  constructor(opts: SophonClientOpts) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
  }

  onUpdate(handler: (u: SophonUpdate) => Promise<void>): void {
    this.updateHandler = handler
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

    return new Promise<void>((resolve, reject) => {
      ws.on('message', (raw) => {
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
      ws.on('close', () => resolve())
      ws.on('error', reject)
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

  /** Atomic non-streaming reply. */
  async sendMessage(input: {
    sessionId: string
    text: string
    interactionId?: string | null
  }): Promise<{ messageId: string }> {
    const data = await this.post('/v1/bridge/sendMessage', {
      session_id: input.sessionId,
      text: input.text,
      idempotency_key: randomUUID(),
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
    })
    const result = (data.result ?? {}) as { message_id?: string }
    return { messageId: result.message_id ?? '' }
  }

  /** Streaming start — reply with empty text so iOS shows a placeholder. */
  async startStreamingMessage(input: {
    sessionId: string
    interactionId?: string | null
  }): Promise<{ messageId: string }> {
    const data = await this.post('/v1/bridge/sendMessage', {
      session_id: input.sessionId,
      text: ' ', // server requires non-empty
      idempotency_key: randomUUID(),
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
    })
    const result = (data.result ?? {}) as { message_id?: string }
    return { messageId: result.message_id ?? '' }
  }

  async sendDelta(messageId: string, delta: string): Promise<void> {
    await this.post('/v1/bridge/sendMessageDelta', {
      message_id: messageId,
      delta,
      idempotency_key: randomUUID(),
    })
  }

  async sendEnd(input: {
    messageId: string
    text?: string
    usage?: Record<string, unknown>
  }): Promise<void> {
    await this.post('/v1/bridge/sendMessageEnd', {
      message_id: input.messageId,
      ...(input.text !== undefined ? { text: input.text } : {}),
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
    // Idempotency key derived from (taskId, phase): same logical
    // tool-call → same key. If the HTTP retry layer fires twice, the
    // server collapses both onto a single task_created SSE event.
    await this.post('/v1/bridge/createTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      kind: input.kind,
      ...(input.statusLabel ? { status_label: input.statusLabel } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
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
    // Update can fire many times for one task. Caller passes a unique
    // taskId per logical update batch; pair with random suffix so
    // multiple progress frames for the same taskId are not collapsed.
    // The retry safety only applies to a single (logical) update —
    // OpenClaw drives one HTTP call per progress frame.
    await this.post('/v1/bridge/updateTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      ...(input.statusLabel ? { status_label: input.statusLabel } : {}),
      ...(input.progressPercent !== undefined ? { progress_percent: input.progressPercent } : {}),
      ...(input.partialResult !== undefined ? { partial_result: input.partialResult } : {}),
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
    // Same as createTask: one logical termination per (taskId,
    // status) — derive a stable key so retries dedupe on the server.
    await this.post('/v1/bridge/finishTask', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      task_id: input.taskId,
      ...(input.name ? { name: input.name } : {}),
      status: input.status,
      ...(input.statusLabel ? { status_label: input.statusLabel } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      idempotency_key: `task:finish:${input.taskId}:${input.status}`,
    })
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
    await this.post('/v1/bridge/requestApproval', {
      session_id: input.sessionId,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      approval_id: input.approvalId,
      ...(input.approvalSlug ? { approval_slug: input.approvalSlug } : {}),
      action: input.action,
      ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
      title: input.title,
      severity: input.severity ?? 'medium',
      ...(input.command ? { command: input.command } : {}),
      ...(input.host ? { host: input.host } : {}),
      message: input.message,
      idempotency_key: randomUUID(),
    })
  }
}
