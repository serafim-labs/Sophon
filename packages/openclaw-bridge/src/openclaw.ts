/**
 * OpenClaw-side WebSocket client. Connects to the user's local
 * gateway with `role: "operator"`, sends `chat.send` requests, and
 * surfaces `agent` stream events (text_delta + final) through a
 * callback.
 *
 * Scope for v0.1:
 *   - Auth via shared `auth.token` (no device-key signing yet —
 *     see TODO at `connect`). The gateway must be configured to
 *     accept token-only operator handshakes.
 *   - chat.send only; chat.history / abort / approvals come later.
 *   - One run can be in flight per (sessionKey) — we hand back
 *     deltas + final via the supplied stream callbacks.
 *
 * If a tool approval lands during a run, we currently log + drop —
 * platform-side approvals (W7) will route them through SAP.
 */

import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

export interface OpenClawClientOpts {
  url: string // ws://localhost:8089
  token: string
  log?: (line: string) => void
}

export interface AgentStreamHandlers {
  onTextDelta?: (delta: string) => void
  onFinal?: (final: { text: string; usage?: Record<string, unknown> }) => void
  onError?: (msg: string) => void
  /** Tool-call lifecycle from OpenClaw `stream:"tool"` frames. Mapped
   *  1-to-1 to OpenClaw's data.phase: start | update | result. The
   *  bridge fans these out as SAP `task_*` events so iOS' existing
   *  ToolGroupView lights up. v0.1 ignored these. */
  onTool?: (event: {
    phase: 'start' | 'update' | 'result'
    toolCallId: string
    name: string
    args?: unknown
    partialResult?: unknown
    result?: unknown
    isError?: boolean
    meta?: unknown
  }) => void
  /** OpenClaw `stream:"approval"` frames. Phase=requested means the
   *  gateway has paused the run and is asking the user to allow/deny
   *  a tool action; phase=resolved is the gateway acknowledging the
   *  decision (informational — no further action). The bridge fans
   *  the `requested` phase out as a SAP `approval_requested` event
   *  through `/v1/bridge/requestApproval` so iOS' ApprovalOptionsSheet
   *  shows allow/deny buttons. */
  onApproval?: (event: {
    phase: 'requested' | 'resolved'
    kind: 'exec' | 'plugin' | string
    status: string
    title: string
    itemId?: string
    toolCallId?: string
    approvalId?: string
    approvalSlug?: string
    command?: string
    host?: string
    reason?: string
    message?: string
  }) => void
}

interface PendingResponse {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
}

export class OpenClawClient {
  private opts: OpenClawClientOpts
  private ws: WebSocket | null = null
  private connected = false
  private deviceToken: string | null = null
  private pending = new Map<string, PendingResponse>()
  private streamHandlers = new Map<string, AgentStreamHandlers>() // runId → handlers
  private streamCumulative = new Map<string, string>() // runId → cumulative text
  private sessionRunIds = new Map<string, string>() // sessionKey → active runId
  // Run-ids whose lifecycle:end carried `replayInvalid: true` — async
  // approval pause. We keep their handlers + cumulative text alive so
  // the followup turn (new runId, same sessionKey) can rebind onto the
  // same listeners and stream the post-approval reply through to iOS.
  private pausedRunIds = new Set<string>()
  // (runId) → set of `${toolCallId}|${phase}` already forwarded to
  // onTool. Dedup guard for OpenClaw's habit of fanning the same
  // tool lifecycle through both `stream:'item' kind:'tool'` AND
  // `stream:'item' kind:'command'` (exec wrapper) at the same
  // toolCallId.
  private toolPhasesSeen = new Map<string, Set<string>>()

  private cleanupRun(runId: string): void {
    this.streamHandlers.delete(runId)
    this.streamCumulative.delete(runId)
    this.toolPhasesSeen.delete(runId)
    this.pausedRunIds.delete(runId)
    for (const [sessionKey, rid] of this.sessionRunIds) {
      if (rid === runId) this.sessionRunIds.delete(sessionKey)
    }
  }

  /** Tie-breaker when an unbound runId arrives without a sessionKey
   *  in the payload. If exactly one paused run exists, that's our
   *  best guess for which session the followup belongs to. */
  private findPausedSessionKey(): string | undefined {
    if (this.pausedRunIds.size !== 1) return undefined
    const [pausedRunId] = this.pausedRunIds
    for (const [sessionKey, rid] of this.sessionRunIds) {
      if (rid === pausedRunId) return sessionKey
    }
    return undefined
  }

  private alreadyForwarded(runId: string, toolCallId: string, phase: string): boolean {
    const key = `${toolCallId}|${phase}`
    let s = this.toolPhasesSeen.get(runId)
    if (!s) {
      s = new Set()
      this.toolPhasesSeen.set(runId, s)
    }
    if (s.has(key)) return true
    s.add(key)
    return false
  }
  private log: (line: string) => void
  private stopped = false

  constructor(opts: OpenClawClientOpts) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
  }

  async connect(): Promise<void> {
    if (this.stopped) throw new Error('client stopped')
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url)
      this.ws = ws
      let challengeNonce: string | null = null

      ws.once('open', () => {
        this.log('[openclaw] socket open')
      })

      ws.on('message', (raw) => {
        let frame: Record<string, unknown> = {}
        try {
          frame = JSON.parse(raw.toString('utf8'))
        } catch {
          return
        }
        const type = String(frame.type ?? '')

        // Pre-handshake — server sends connect.challenge first.
        if (type === 'event' && frame.event === 'connect.challenge') {
          const payload = (frame.payload ?? {}) as { nonce?: string }
          challengeNonce = payload.nonce ?? null
          // Send our handshake. TODO(v0.2): sign the nonce with a
          // persisted Ed25519 keypair when the gateway requires it.
          // OpenClaw only accepts a fixed set of client.id / client.mode
          // values (see reference/openclaw-full/src/gateway/protocol/
          // client-info.ts). 'gateway-client' + 'backend' is the right
          // identity for a server-style operator (programmatic, no UI).
          // `client.platform` is mandatory.
          const handshake = {
            type: 'req',
            id: randomUUID(),
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'gateway-client',
                displayName: 'Sophon OpenClaw Bridge',
                version: '0.1.0',
                platform: `node${process.versions.node.split('.')[0]}-${process.platform}`,
                mode: 'backend',
              },
              role: 'operator',
              // operator.approvals is the scope the gateway gates
              // exec.approval.resolve / plugin.approval.resolve on
              // (W12 Phase 2). Without it the bridge can mirror
              // approvals out to iOS but can't push the user's
              // decision back into OpenClaw.
              scopes: ['operator.read', 'operator.write', 'operator.approvals'],
              auth: this.deviceToken
                ? { token: this.opts.token, deviceToken: this.deviceToken }
                : { token: this.opts.token },
            },
          }
          // We deliberately drop `nonceEcho` — the gateway schema rejects
          // unknown properties. Device-key signing (the proper response
          // to the challenge) is a v0.2 item; many gateways accept
          // token-only auth without it.
          ws.send(JSON.stringify(handshake))
          return
        }

        // Handshake response.
        if (type === 'res' && !this.connected) {
          if (frame.ok === true) {
            const payload = (frame.payload ?? {}) as { auth?: { deviceToken?: string } }
            this.deviceToken = payload.auth?.deviceToken ?? this.deviceToken
            this.connected = true
            this.log('[openclaw] connected')
            resolve()
          } else {
            const err = (frame.error ?? {}) as { code?: string; message?: string }
            const msg = `connect failed: ${err.code ?? '?'} ${err.message ?? ''}`
            this.log(`[openclaw] ${msg}`)
            reject(new Error(msg))
          }
          return
        }

        // Subsequent res frames — RPC replies.
        if (type === 'res') {
          const id = String(frame.id ?? '')
          const p = this.pending.get(id)
          if (p) {
            this.pending.delete(id)
            if (frame.ok === true) p.resolve(frame.payload)
            else {
              const err = (frame.error ?? {}) as { code?: string; message?: string }
              p.reject(new Error(`${err.code ?? 'rpc_error'}: ${err.message ?? ''}`))
            }
          }
          return
        }

        // Streaming events. OpenClaw fires TWO event channels for
        // assistant text:
        //   `agent` with stream='assistant'   — carries `data.delta`
        //                                        (incremental) plus
        //                                        `data.text` (cumulative);
        //                                        also `stream='lifecycle'`
        //                                        with `data.phase='end'`
        //                                        for completion
        //   `chat`  with state='delta'|'final' — UI-friendly stream
        //                                        with `message.content[]`
        //                                        carrying CUMULATIVE text
        //
        // We listen on `agent` for text deltas (cleaner — has the
        // incremental delta directly) and on `chat` for the final
        // canonical text. lifecycle:end on `agent` triggers final
        // even if no `chat` final landed.
        if (type === 'event' && frame.event === 'agent') {
          const payload = (frame.payload ?? {}) as {
            runId?: string
            stream?: string
            data?: Record<string, unknown> & { text?: string; delta?: string; phase?: string; reason?: string }
          }
          const runId = payload.runId
          if (!runId) return
          let handlers = this.streamHandlers.get(runId)
          if (!handlers) {
            // Followup-after-approval rebind. OpenClaw mints a fresh
            // runId for the post-approval continuation; events arrive
            // here with no listener. If a paused run exists for the
            // same sessionKey, migrate its handlers + cumulative
            // buffer to the new runId so the followup streams
            // through unchanged.
            const sessionKey = (payload.data as { sessionKey?: string })?.sessionKey
              ?? this.findPausedSessionKey()
            if (sessionKey) {
              const pausedRunId = this.sessionRunIds.get(sessionKey)
              if (pausedRunId && this.pausedRunIds.has(pausedRunId)) {
                handlers = this.streamHandlers.get(pausedRunId)
                if (handlers) {
                  this.streamHandlers.set(runId, handlers)
                  const carry = this.streamCumulative.get(pausedRunId) ?? ''
                  this.streamCumulative.set(runId, carry)
                  this.streamCumulative.delete(pausedRunId)
                  this.streamHandlers.delete(pausedRunId)
                  this.toolPhasesSeen.set(runId, this.toolPhasesSeen.get(pausedRunId) ?? new Set())
                  this.toolPhasesSeen.delete(pausedRunId)
                  this.sessionRunIds.set(sessionKey, runId)
                  this.pausedRunIds.delete(pausedRunId)
                  this.log(`[openclaw] followup rebind: paused ${pausedRunId} → ${runId} (session=${sessionKey})`)
                }
              }
            }
            if (!handlers) return
          }
          // Trace every agent frame in verbose mode so unexpected
          // wire shapes (new stream channels, missing toolCallIds,
          // …) are visible without re-instrumenting the file.
          this.log(`[openclaw] agent stream=${payload.stream ?? '?'} phase=${payload.data?.phase ?? '?'} keys=${Object.keys(payload.data ?? {}).join(',')}`)

          if (payload.stream === 'assistant') {
            const delta = payload.data?.delta ?? ''
            if (delta) {
              this.streamCumulative.set(
                runId,
                (this.streamCumulative.get(runId) ?? '') + delta,
              )
              if (handlers.onTextDelta) handlers.onTextDelta(delta)
            }
            return
          }
          if (payload.stream === 'lifecycle' && payload.data?.phase === 'end') {
            // OpenClaw signals "this run paused on async approval, more
            // events will arrive on a new runId after the user
            // resolves" via `replayInvalid: true` on the lifecycle-end
            // frame. Without this guard bridge fired `onFinal` with
            // empty text, sendEnd closed the iOS bubble, and the
            // followup-turn events that landed after the user tapped
            // approve never made it through (handlers cleaned up,
            // followup runId had no listener). Treat replayInvalid as
            // a soft-pause: keep handlers + cumulative buffer alive and
            // also re-bind the next runId for this sessionKey so the
            // followup turn flows through the same handler chain.
            const replayInvalid = (payload.data as { replayInvalid?: boolean })?.replayInvalid === true
            if (replayInvalid) {
              this.log(`[openclaw] lifecycle:end replayInvalid=true — pausing run ${runId} (await followup)`)
              this.pausedRunIds.add(runId)
              return
            }
            const finalText = this.streamCumulative.get(runId) ?? ''
            if (handlers.onFinal) handlers.onFinal({ text: finalText })
            this.cleanupRun(runId)
            return
          }
          if (payload.stream === 'lifecycle' && payload.data?.phase === 'error') {
            if (handlers.onError) handlers.onError(payload.data?.reason ?? 'lifecycle error')
            this.cleanupRun(runId)
            return
          }
          if (payload.stream === 'error') {
            if (handlers.onError) handlers.onError(payload.data?.reason ?? 'stream error')
            this.cleanupRun(runId)
            return
          }
          // Tool surface. OpenClaw fans tool lifecycle through TWO
          // overlapping channels:
          //   - `stream:"item"` with `kind: "tool" | "command" |
          //     "patch"` — high-level start/update/end with the
          //     human-readable title, status, and summary. This is
          //     what iOS' ToolGroupView wants.
          //   - `stream:"tool"` — raw provider frames with args /
          //     partialResult / result blobs. Some OpenClaw builds
          //     emit it, some don't; we accept both so the SAP
          //     task_* event still fires no matter which channel
          //     the gateway uses.
          //   - `stream:"command_output"` — live exec stdout/stderr
          //     for bash/exec items. For v1 we don't relay this
          //     (iOS UI doesn't render live tool stdout); v2 can
          //     fold it onto task_progress.partial_result.
          if (payload.stream === 'item') {
            const data = (payload.data ?? {}) as {
              itemId?: string
              phase?: string
              kind?: string
              title?: string
              status?: string
              name?: string
              toolCallId?: string
              summary?: string
              progressText?: string
              meta?: unknown
            }
            // Only relay tool-shaped items. `kind` is the OpenClaw-
            // side category — "tool" for general LLM tool calls,
            // "command" for bash/exec, "patch" for file edits.
            const kind = data.kind
            if (kind !== 'tool' && kind !== 'command' && kind !== 'patch') return
            // Prefer toolCallId (stable across phases of the same
            // call); fall back to itemId (stable too, just longer).
            const toolCallId = data.toolCallId ?? data.itemId
            if (!toolCallId || !handlers.onTool) return
            const name = data.name ?? kind
            if (data.phase === 'start') {
              if (this.alreadyForwarded(runId, toolCallId, 'start')) return
              handlers.onTool({ phase: 'start', toolCallId, name, args: data.title ? { title: data.title } : undefined })
              return
            }
            if (data.phase === 'update') {
              // Don't dedup — multiple distinct progress ticks are real.
              handlers.onTool({
                phase: 'update', toolCallId, name,
                partialResult: data.progressText,
              })
              return
            }
            if (data.phase === 'end') {
              if (this.alreadyForwarded(runId, toolCallId, 'end')) return
              const isError = data.status === 'failed' || data.status === 'errored' || data.status === 'denied' || data.status === 'blocked'
              handlers.onTool({
                phase: 'result', toolCallId, name,
                result: data.summary, isError, meta: data.meta,
              })
              return
            }
            return
          }
          if (payload.stream === 'tool') {
            const data = (payload.data ?? {}) as {
              phase?: string
              name?: string
              toolCallId?: string
              args?: unknown
              partialResult?: unknown
              result?: unknown
              isError?: boolean
              meta?: unknown
            }
            const toolCallId = data.toolCallId
            const name = data.name ?? 'tool'
            if (!toolCallId || !handlers.onTool) return
            if (data.phase === 'start') {
              handlers.onTool({ phase: 'start', toolCallId, name, args: data.args })
              return
            }
            if (data.phase === 'update') {
              handlers.onTool({
                phase: 'update', toolCallId, name,
                partialResult: data.partialResult,
              })
              return
            }
            if (data.phase === 'result') {
              handlers.onTool({
                phase: 'result', toolCallId, name,
                result: data.result, isError: data.isError, meta: data.meta,
              })
              return
            }
            return
          }
          // Approvals — phase: requested | resolved. Forwarded
          // 1-to-1 to onApproval; the bridge then fans `requested`
          // out as SAP approval_requested. `resolved` is informational
          // (the gateway echoing the user's decision) — bridge logs
          // and drops.
          if (payload.stream === 'approval') {
            const data = (payload.data ?? {}) as {
              phase?: string
              kind?: string
              status?: string
              title?: string
              itemId?: string
              toolCallId?: string
              approvalId?: string
              approvalSlug?: string
              command?: string
              host?: string
              reason?: string
              message?: string
            }
            if (!handlers.onApproval) return
            const phase = data.phase === 'resolved' ? 'resolved' : 'requested'
            handlers.onApproval({
              phase,
              kind: data.kind ?? 'exec',
              status: data.status ?? 'pending',
              title: data.title ?? 'Approval requested',
              itemId: data.itemId,
              toolCallId: data.toolCallId,
              approvalId: data.approvalId,
              approvalSlug: data.approvalSlug,
              command: data.command,
              host: data.host,
              reason: data.reason,
              message: data.message,
            })
            return
          }
          // Other streams (reasoning, plan, thinking, command_output,
          // …) — ignored for v0.1.
          return
        }

        if (type === 'event' && frame.event === 'chat') {
          const payload = (frame.payload ?? {}) as {
            runId?: string
            state?: string
            message?: { content?: Array<{ type?: string; text?: string }> }
            usage?: Record<string, unknown>
            errorMessage?: string
          }
          const runId = payload.runId
          if (!runId) return
          const handlers = this.streamHandlers.get(runId)
          if (!handlers) return

          const fullText = (payload.message?.content ?? [])
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('')

          // For `chat` events we trust state='final' as the canonical
          // text — agent stream might miss the very last chunk if the
          // run aborts. Delta path goes through `agent` event above.
          if (payload.state === 'final') {
            // If this run is paused on async approval, the chat
            // channel still emits `state=final` for the pre-approval
            // sub-turn. Suppress onFinal in that case so iOS doesn't
            // see sendEnd before the approved followup arrives.
            if (this.pausedRunIds.has(runId)) {
              this.log(`[openclaw] chat:final for paused run ${runId} — suppressing onFinal (await followup)`)
              return
            }
            const finalText = fullText || this.streamCumulative.get(runId) || ''
            if (handlers.onFinal) handlers.onFinal({ text: finalText, usage: payload.usage })
            this.cleanupRun(runId)
            return
          }
          if (payload.state === 'delta') {
            // Diff cumulative just in case — though `agent` stream
            // already streamed deltas. Belt and suspenders.
            const prev = this.streamCumulative.get(runId) ?? ''
            if (fullText.length > prev.length) {
              const tail = fullText.slice(prev.length)
              this.streamCumulative.set(runId, fullText)
              if (tail && handlers.onTextDelta) handlers.onTextDelta(tail)
            }
            return
          }

          if (payload.state === 'aborted' || payload.state === 'error') {
            const msg = payload.errorMessage ?? payload.state ?? 'unknown error'
            if (handlers.onError) handlers.onError(msg)
            this.cleanupRun(runId)
            return
          }
        }

        // tick keepalive — ignore.
        if (type === 'event' && frame.event === 'tick') return

        // Anything else: log with brief shape so unknown wire is visible.
        const ev = frame.event ?? type
        const shape = type === 'event'
          ? `payload.runId=${(frame.payload as Record<string, unknown> | undefined)?.runId ?? '?'} state=${(frame.payload as Record<string, unknown> | undefined)?.state ?? '?'} stream=${(frame.payload as Record<string, unknown> | undefined)?.stream ?? '?'}`
          : ''
        this.log(`[openclaw] event ${ev} ${shape}`)
      })

      ws.once('close', () => {
        this.connected = false
        this.log('[openclaw] socket closed')
        // Reject all pending RPCs to unblock callers.
        for (const [id, p] of this.pending) {
          this.pending.delete(id)
          p.reject(new Error('socket closed'))
        }
      })
      ws.once('error', (err) => {
        if (!this.connected) reject(err)
        this.log(`[openclaw] error: ${err.message}`)
      })
    })
  }

  stop(): void {
    this.stopped = true
    this.ws?.close()
  }

  /**
   * Send a chat message into the user's OpenClaw and stream the
   * response back via the supplied handlers. Returns when the gateway
   * acknowledges the chat.send call (NOT when streaming completes).
   */
  async chatSend(input: {
    sessionKey: string
    message: string
    /** Optional file/image attachments in OpenClaw's `chat.send`
     *  attachment shape — `{ mimeType, fileName, content: <base64> }`.
     *  bridge.ts is responsible for fetching the source bytes (R2 or
     *  inline) and base64-encoding before this point; OpenClaw's
     *  attachment normaliser rejects anything else. */
    attachments?: ReadonlyArray<{
      mimeType: string
      fileName: string
      content: string
    }>
    handlers: AgentStreamHandlers
  }): Promise<{ runId: string }> {
    if (!this.connected || !this.ws) throw new Error('not connected')

    const reqId = randomUUID()
    const idempotencyKey = randomUUID()
    const params: Record<string, unknown> = {
      sessionKey: input.sessionKey,
      message: input.message,
      idempotencyKey,
    }
    if (input.attachments && input.attachments.length > 0) {
      params.attachments = input.attachments
    }
    const payload = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.ws!.send(
        JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.send',
          params,
        }),
      )
    })

    const result = (payload ?? {}) as { runId?: string }
    const runId = result.runId ?? randomUUID()
    this.log(`[openclaw] chat.send ack runId=${runId} sessionKey=${input.sessionKey}`)
    this.streamHandlers.set(runId, input.handlers)
    this.sessionRunIds.set(input.sessionKey, runId)
    return { runId }
  }

  /**
   * Resolve a pending tool approval. OpenClaw exposes
   * `exec.approval.resolve` for shell/exec calls and
   * `plugin.approval.resolve` for plugin-tool calls. Both accept
   * `{approvalId, decision}` where decision ∈ {allow-once, allow-always,
   * deny}.
   *
   * SAP iOS-side decisions are `approve | approve_always | deny` —
   * caller maps before calling.
   *
   * Approval IDs starting with `plugin:` route to the plugin RPC; all
   * other ids route to the exec RPC. Mirrors OpenClaw's own
   * `resolveApprovalMethods` switch.
   */
  async respondApproval(input: {
    approvalId: string
    decision: 'allow-once' | 'allow-always' | 'deny'
  }): Promise<void> {
    if (!this.connected || !this.ws) throw new Error('not connected')
    const method = input.approvalId.startsWith('plugin:')
      ? 'plugin.approval.resolve'
      : 'exec.approval.resolve'
    const reqId = randomUUID()
    await new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.ws!.send(
        JSON.stringify({
          type: 'req',
          id: reqId,
          method,
          // OpenClaw's schema for exec.approval.resolve uses `id` for
          // the approval — NOT `approvalId`. Discovered live: the
          // gateway returns `INVALID_REQUEST: must have required
          // property 'id'; unexpected property 'approvalId'`.
          params: {
            id: input.approvalId,
            decision: input.decision,
          },
        }),
      )
    })
    this.log(`[openclaw] ${method} resolved approvalId=${input.approvalId} decision=${input.decision}`)
  }
}
