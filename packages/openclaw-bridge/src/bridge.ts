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

import type { SophonClient, SophonUpdate } from './sophon.js'
import type { OpenClawClient } from './openclaw.js'

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
}

export class Bridge {
  private sophon: SophonClient
  private openclaw: OpenClawClient
  private log: (line: string) => void
  private debugStream: boolean

  constructor(opts: BridgeOpts) {
    this.sophon = opts.sophon
    this.openclaw = opts.openclaw
    this.log = opts.log ?? (() => {})
    this.debugStream = opts.debugStream ?? false
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
        // TODO: forward as chat.abort to OpenClaw.
        this.log(`[bridge] session.cancelled — abort not yet wired`)
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
        attachments?: Array<{
          key?: string
          url?: string
          mime?: string
          name?: string | null
        }>
      }
    }
    const sessionId = payload.session?.id ?? u.session_id ?? ''
    const text = payload.message?.text ?? ''
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
        await this.sophon.sendDelta(messageId, chunk)
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
        text: `[OpenClaw error] ${(err as Error).message}`,
      })
    }
  }
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
