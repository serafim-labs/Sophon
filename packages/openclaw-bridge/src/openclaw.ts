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

/**
 * Range of OpenClaw gateway protocol versions this bridge understands.
 *
 * OpenClaw bumped `PROTOCOL_VERSION` from 3 → 4 around the 5.5/5.6
 * release (5.7 briefly went back to 3 due to a botched build, then
 * 5.9-beta.1+ landed firmly on 4). The `ConnectParamsSchema` payload
 * is identical between v3 and v4 — only the version-number gate
 * moved — so we declare the union range and let the gateway pick.
 *
 * If a future gateway requires a version outside this band, the
 * handshake response surfaces `details.expectedProtocol` (see the
 * "connect failed" branch in the message handler), and the error
 * message tells the user exactly which version to install. Keep the
 * constants in sync with the actual `ConnectParamsSchema` shape if
 * the gateway ever adds required fields per protocol bump.
 */
export const OPENCLAW_MIN_PROTOCOL = 3
export const OPENCLAW_MAX_PROTOCOL = 4

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

/// Payload shape for an `event: 'cron'` frame from OpenClaw. Most
/// fields are optional because the gateway emits this event for several
/// transitions (started, progress, finished, error) and they don't all
/// carry the same metadata.
export interface CronEventPayload {
  runId?: string
  jobId?: string
  jobName?: string
  /** Internal OpenClaw session id for the run (UUID). Distinct from
   *  any Sophon session id the bridge may mint to host the transcript. */
  sessionId?: string
  state?: string
  status?: string
  [key: string]: unknown
}

/** Reconnect-loop backoff bounds (close handler in OpenClawClient). */
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 30_000

export class OpenClawClient {
  private opts: OpenClawClientOpts
  private ws: WebSocket | null = null
  private connected = false
  private deviceToken: string | null = null
  private pending = new Map<string, PendingResponse>()
  private streamHandlers = new Map<string, AgentStreamHandlers>() // runId → handlers
  private streamCumulative = new Map<string, string>() // runId → cumulative text
  private cronEventHandlers: Array<(payload: CronEventPayload) => void> = []
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

  /// Subscribe to OpenClaw cron events. Each callback receives the raw
  /// payload (state/runId/jobId/sessionId/...). Returns an unsubscribe
  /// function. Used by the bridge to detect cron runs and lazily mint
  /// a Sophon session that hosts the transcript + approvals.
  onCronEvent(handler: (payload: CronEventPayload) => void): () => void {
    this.cronEventHandlers.push(handler)
    return () => {
      this.cronEventHandlers = this.cronEventHandlers.filter((h) => h !== handler)
    }
  }

  /// External hook to inject stream handlers for a known runId. The
  /// bridge calls this after registering on a cron event so subsequent
  /// `chat`, `agent`, `tool`, `approval` frames for that runId fan out
  /// through the same machinery user-initiated `chat.send` uses.
  registerStreamHandlers(runId: string, handlers: AgentStreamHandlers): void {
    this.streamHandlers.set(runId, handlers)
  }

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
  /** Exponential-backoff state for the close-handler reconnect loop.
   *  Reset to RECONNECT_MIN_MS on every clean handshake. */
  private reconnectMs = RECONNECT_MIN_MS
  private reconnecting = false
  /** Fires whenever the WS goes from disconnected → connected (re-)
   *  established. Subscribers (the connector runner) use it to
   *  re-emit `openclaw_connected` so health flips back to healthy. */
  private reconnectListeners: Array<() => void> = []

  constructor(opts: OpenClawClientOpts) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
  }

  /** Register a callback fired after every *re*-connect (not the first
   *  one — that's `await connect()`'s return). */
  onReconnect(handler: () => void): void {
    this.reconnectListeners.push(handler)
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
              // See OPENCLAW_{MIN,MAX}_PROTOCOL doc — we span the
              // gateway's known PROTOCOL_VERSION values (3 and 4) so
              // one binary works against any supported openclaw
              // release. The error branch below reads the gateway's
              // `expectedProtocol` if the next bump shifts the window.
              minProtocol: OPENCLAW_MIN_PROTOCOL,
              maxProtocol: OPENCLAW_MAX_PROTOCOL,
              client: {
                id: 'gateway-client',
                displayName: 'Sophon OpenClaw Bridge',
                version: '0.1.0',
                platform: `node${process.versions.node.split('.')[0]}-${process.platform}`,
                mode: 'backend',
              },
              role: 'operator',
              // operator.approvals gates exec/plugin approval resolves;
              // operator.admin gates sessions.patch (the model-selection
              // surface). Bridge runs as gateway-client/backend over
              // direct-local loopback with the operator token from
              // ~/.openclaw/openclaw.json — that token already holds
              // CLI_DEFAULT_OPERATOR_SCOPES (incl. admin), and the
              // local-backend self-pair bypass preserves self-declared
              // scopes for this exact client profile.
              scopes: ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin'],
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
            this.reconnectMs = RECONNECT_MIN_MS
            this.log('[openclaw] connected')
            resolve()
          } else {
            // Surface server-provided details (gateway packs
            // `expectedProtocol`, supported scopes, etc. into
            // `error.details`). Without this all the user sees is
            // "INVALID_REQUEST protocol mismatch" and has no idea
            // which version of the connector to install.
            const err = (frame.error ?? {}) as {
              code?: string
              message?: string
              details?: Record<string, unknown>
            }
            const detailsRaw = err.details
            const expected =
              detailsRaw && typeof detailsRaw.expectedProtocol === 'number'
                ? (detailsRaw.expectedProtocol as number)
                : null
            const parts = [`connect failed: ${err.code ?? '?'} ${err.message ?? ''}`]
            if (expected !== null) {
              // 3 / 4 are the only values that ever shipped — we span
              // both, so a future bump (5+) is the only way this fires
              // for an up-to-date connector.
              parts.push(
                `(gateway expects PROTOCOL_VERSION=${expected}; this bridge offers ${OPENCLAW_MIN_PROTOCOL}..${OPENCLAW_MAX_PROTOCOL})`,
              )
              parts.push(
                `→ update @sophonai/bridge (npm i -g @sophonai/bridge@latest), or downgrade openclaw to a version with PROTOCOL_VERSION in ${OPENCLAW_MIN_PROTOCOL}..${OPENCLAW_MAX_PROTOCOL}`,
              )
            } else if (detailsRaw) {
              parts.push(`details=${JSON.stringify(detailsRaw)}`)
            }
            const msg = parts.join(' ')
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

          if (payload.state === 'aborted') {
            // User-initiated stop. Treat as a graceful finalisation
            // instead of an error — iOS shouldn't see "[OpenClaw error]
            // aborted" when the user themselves tapped Stop. Whatever
            // streamed before the abort stays as the bubble content;
            // if nothing streamed, we still close cleanly with empty
            // text. The lifecycle:end frame that follows is a no-op
            // because cleanupRun removed the handlers.
            const finalText = this.streamCumulative.get(runId) ?? ''
            if (handlers.onFinal) handlers.onFinal({ text: finalText })
            this.cleanupRun(runId)
            return
          }
          if (payload.state === 'error') {
            const msg = payload.errorMessage ?? 'unknown error'
            if (handlers.onError) handlers.onError(msg)
            this.cleanupRun(runId)
            return
          }
        }

        // tick keepalive — ignore.
        if (type === 'event' && frame.event === 'tick') return

        // Cron lifecycle. OpenClaw fires `event:cron` with a payload
        // carrying { runId, jobId, jobName, sessionId, state, status, ... }
        // for routine starts, progress, and completion. The bridge
        // subscribes via `onCronEvent` to lazy-mint a Sophon session
        // for each run and inject stream handlers (so subsequent
        // `agent`/`chat`/`tool`/`approval` frames for the cron's runId
        // route through the same machinery as user-initiated chats).
        if (type === 'event' && frame.event === 'cron') {
          const payload = (frame.payload ?? {}) as CronEventPayload
          this.log(`[openclaw] cron event runId=${payload.runId ?? '?'} state=${payload.state ?? '?'} jobId=${payload.jobId ?? '?'}`)
          for (const h of this.cronEventHandlers) {
            try {
              h(payload)
            } catch (err) {
              this.log(`[openclaw] cron handler threw: ${(err as Error).message}`)
            }
          }
          return
        }

        // Anything else: log with brief shape so unknown wire is visible.
        const ev = frame.event ?? type
        const shape = type === 'event'
          ? `payload.runId=${(frame.payload as Record<string, unknown> | undefined)?.runId ?? '?'} state=${(frame.payload as Record<string, unknown> | undefined)?.state ?? '?'} stream=${(frame.payload as Record<string, unknown> | undefined)?.stream ?? '?'}`
          : ''
        this.log(`[openclaw] event ${ev} ${shape}`)
      })

      ws.once('close', () => {
        const wasConnected = this.connected
        this.connected = false
        this.log('[openclaw] socket closed')
        // Reject all pending RPCs to unblock callers.
        for (const [id, p] of this.pending) {
          this.pending.delete(id)
          p.reject(new Error('socket closed'))
        }
        // Drop run-id maps — the openclaw process on the other side may
        // have restarted; any cached run ids are stale. Stream handlers
        // are tied to the (now-rejected) inflight chat.send calls — the
        // bridge will retry via Sophon at the next user message.
        this.streamHandlers.clear()
        this.streamCumulative.clear()
        this.sessionRunIds.clear()
        this.pausedRunIds.clear()
        this.toolPhasesSeen.clear()
        // Kick reconnect loop. Only when we were actually connected
        // (otherwise initial-connect failures fall through to caller
        // via the `connect()` promise reject path).
        if (wasConnected && !this.stopped && !this.reconnecting) {
          void this.reconnectLoop()
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

  /** Background loop: after the WS dropped, reconnect with
   *  exponential backoff (cap RECONNECT_MAX_MS). Exits on `stop()` or
   *  on the first successful `connect()`. The handshake inside
   *  `connect()` resets `reconnectMs` back to MIN. */
  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    try {
      while (!this.stopped) {
        const jitter = Math.floor(Math.random() * 250)
        const wait = Math.min(this.reconnectMs + jitter, RECONNECT_MAX_MS)
        this.log(`[openclaw] reconnecting in ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
        if (this.stopped) return
        try {
          await this.connect()
          this.log('[openclaw] reconnected')
          this.reconnectMs = RECONNECT_MIN_MS
          for (const handler of this.reconnectListeners) {
            try { handler() } catch { /* listener errors must not stall loop */ }
          }
          return
        } catch (err) {
          this.reconnectMs = Math.min(
            Math.floor(this.reconnectMs * 1.8),
            RECONNECT_MAX_MS,
          )
          this.log(`[openclaw] reconnect failed: ${(err as Error).message}`)
        }
      }
    } finally {
      this.reconnecting = false
    }
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
   * Abort an in-flight chat run. Mirrors the gateway's `chat.abort`
   * RPC (`reference: openclaw-full/src/gateway/server-methods/chat.ts`):
   *
   *   params: { sessionKey: string, runId?: string }
   *   response: { ok: true, aborted: boolean, runIds: string[] }
   *
   * When `runId` is omitted, the gateway aborts every active run for
   * the given `sessionKey`. That's the right shape for SAP's
   * `session.cancelled` (user tapped Stop on the chat) — the user
   * means "stop everything in this chat right now", not "stop run X".
   *
   * Returns the response payload so the caller can log how many runs
   * were actually aborted; zero is a valid no-op (the run may have
   * finalised between the SAP cancel and this RPC).
   */
  async chatAbort(input: {
    sessionKey: string
    runId?: string
  }): Promise<{ aborted: boolean; runIds: string[] }> {
    if (!this.connected || !this.ws) throw new Error('not connected')
    const reqId = randomUUID()
    const params: Record<string, unknown> = { sessionKey: input.sessionKey }
    if (input.runId) params.runId = input.runId
    const payload = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.ws!.send(
        JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.abort',
          params,
        }),
      )
    })
    const result = (payload ?? {}) as {
      aborted?: boolean
      runIds?: string[]
    }
    const aborted = result.aborted ?? false
    const runIds = result.runIds ?? []
    this.log(
      `[openclaw] chat.abort ack sessionKey=${input.sessionKey}` +
        (input.runId ? ` runId=${input.runId}` : '') +
        ` aborted=${aborted} runIds=[${runIds.join(',')}]`,
    )
    // Best-effort local bookkeeping: drop the sessionKey→runId binding
    // so a follow-up chat.send for this sessionKey doesn't try to bind
    // a fresh runId onto the now-aborted slot.
    if (aborted) {
      const tracked = this.sessionRunIds.get(input.sessionKey)
      if (tracked && (!input.runId || tracked === input.runId)) {
        this.sessionRunIds.delete(input.sessionKey)
      }
    }
    return { aborted, runIds }
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

  /**
   * Fetch the gateway's allowed model catalog. Mirrors `models.list`
   * server-method (`reference/openclaw-full/src/gateway/server-methods/
   * models.ts`) — read scope only, returns `{ models: ModelCatalogEntry[] }`
   * filtered by `cfg`'s allowedModels.
   *
   * Entries follow the OpenClaw model-catalog shape:
   *   { id, name, provider, alias?, contextWindow?, reasoning?, input?[] }
   * iOS uses `id` as the value to send back through `sessions.patch`,
   * `name` for the row label, `provider` for grouping, `input` for the
   * vision/document affordance gate.
   */
  async modelsList(): Promise<{
    models: Array<{
      id: string
      name: string
      provider: string
      alias?: string
      contextWindow?: number
      reasoning?: boolean
      input?: ReadonlyArray<'text' | 'image' | 'document'>
    }>
  }> {
    if (!this.connected || !this.ws) throw new Error('not connected')
    const reqId = randomUUID()
    const payload = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.ws!.send(
        JSON.stringify({ type: 'req', id: reqId, method: 'models.list', params: {} }),
      )
    })
    const result = (payload ?? {}) as {
      models?: Array<{
        id: string
        name: string
        provider: string
        alias?: string
        contextWindow?: number
        reasoning?: boolean
        input?: ReadonlyArray<'text' | 'image' | 'document'>
      }>
    }
    return { models: result.models ?? [] }
  }

  /**
   * Patch a session's settings. Maps to `sessions.patch` server-method
   * (`reference/openclaw-full/src/gateway/server-methods/sessions.ts`,
   * admin scope). v1 surfaces only the `model` field — passing `null`
   * resets to the agent's default; passing a model id stamps it on the
   * session's `entry.modelOverride` so the next `chat.send` resolves it
   * via `resolveSessionModelRef`.
   *
   * Idempotent on the gateway side: setting the same model twice is a
   * no-op except for `updatedAt`. Bridge tracks `lastAppliedModel` per
   * sessionKey to skip redundant round-trips on the hot send path; this
   * RPC remains the canonical way to switch model.
   */
  async sessionsPatch(input: {
    sessionKey: string
    /** Model id from `models.list` (e.g. `"sonnet-4.6"`), or `null`
     *  to reset the override and fall back to the agent default. */
    model: string | null
  }): Promise<void> {
    if (!this.connected || !this.ws) throw new Error('not connected')
    const reqId = randomUUID()
    await new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.ws!.send(
        JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'sessions.patch',
          params: { key: input.sessionKey, model: input.model },
        }),
      )
    })
    this.log(
      `[openclaw] sessions.patch ack sessionKey=${input.sessionKey} model=${input.model ?? 'null'}`,
    )
  }

  // MARK: - cron (routines) — wraps the gateway's `cron.*` server-methods
  //
  // OpenClaw is the source of truth for routines. Every Sophon UI call
  // ends up here through the bridge's `cron.*.req` RPC dispatch. The
  // params/results shapes are passed through unchanged — see
  // `reference/openclaw-full/src/gateway/protocol/schema/cron.ts` for
  // the canonical contract (CronJob, CronListParams, etc.).

  /** Generic cron request — params and result are the gateway's wire shapes. */
  private async cronRpc(
    method:
      | 'cron.list'
      | 'cron.status'
      | 'cron.add'
      | 'cron.update'
      | 'cron.remove'
      | 'cron.run'
      | 'cron.runs',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.connected || !this.ws) throw new Error('not connected')
    const reqId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.ws!.send(JSON.stringify({ type: 'req', id: reqId, method, params }))
    })
  }

  cronList(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.cronRpc('cron.list', params)
  }
  cronStatus(): Promise<unknown> {
    return this.cronRpc('cron.status', {})
  }
  cronAdd(params: Record<string, unknown>): Promise<unknown> {
    return this.cronRpc('cron.add', params)
  }
  cronUpdate(params: Record<string, unknown>): Promise<unknown> {
    return this.cronRpc('cron.update', params)
  }
  cronRemove(params: Record<string, unknown>): Promise<unknown> {
    return this.cronRpc('cron.remove', params)
  }
  cronRun(params: Record<string, unknown>): Promise<unknown> {
    return this.cronRpc('cron.run', params)
  }
  cronRuns(params: Record<string, unknown>): Promise<unknown> {
    return this.cronRpc('cron.runs', params)
  }
}
