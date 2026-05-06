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
}

export class Bridge {
  private sophon: SophonClient
  private openclaw: OpenClawClient
  private log: (line: string) => void

  constructor(opts: BridgeOpts) {
    this.sophon = opts.sophon
    this.openclaw = opts.openclaw
    this.log = opts.log ?? (() => {})
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
    // Pass through any signed attachment URLs so OpenClaw can pull
    // the bytes itself. Keep only entries with a usable url+mime; drop
    // half-built rows.
    const attachments = (payload.message?.attachments ?? [])
      .filter((a): a is { url: string; mime: string; name?: string | null } =>
        typeof a.url === 'string' && a.url.length > 0 && typeof a.mime === 'string' && a.mime.length > 0,
      )
      .map((a) => ({ url: a.url, mime: a.mime, name: a.name ?? null }))

    // 1. Pre-create a streaming agent message in Sophon so iOS sees a
    //    placeholder bubble immediately (otherwise the user waits in
    //    silence while OpenClaw chews on the prompt).
    const interactionId = u.interaction_id
    const { messageId } = await this.sophon.startStreamingMessage({
      sessionId,
      interactionId,
    })

    let accumulated = ''
    let pendingPromise: Promise<void> = Promise.resolve()
    const enqueue = (work: () => Promise<void>) => {
      pendingPromise = pendingPromise.then(work).catch((err) => {
        this.log(`[bridge] sophon push failed: ${(err as Error).message}`)
      })
    }

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
            enqueue(() => this.sophon.sendDelta(messageId, delta))
          },
          onFinal: (final) => {
            const finalText = final.text || accumulated
            enqueue(() =>
              this.sophon.sendEnd({
                messageId,
                text: finalText,
                usage: final.usage,
              }),
            )
          },
          onError: (msg) => {
            enqueue(() =>
              this.sophon.sendEnd({
                messageId,
                text: accumulated || `[OpenClaw error] ${msg}`,
              }),
            )
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
            const messageBody = ev.message
              ?? (ev.command ? `Run \`${ev.command}\`?` : ev.title)
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
