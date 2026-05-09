/**
 * `createBot` — minimum surface for a webhook-mode SAP agent.
 *
 * Usage:
 *   const bot = createBot({
 *     token: process.env.SOPHON_TOKEN!,
 *     webhookSecret: process.env.SOPHON_WEBHOOK_SECRET!,
 *     baseURL: process.env.SOPHON_BASE_URL ?? 'https://api.schat.app',
 *   })
 *   bot.on('session.message', async (ctx) => {
 *     await ctx.sendMessage(`echo: ${ctx.message.text}`)
 *   })
 *   const port = Number(process.env.PORT ?? 3030)
 *   serve({ fetch: bot.fetch, port })
 */

import { Hono } from 'hono'
import { verifyWebhookSignature } from './signature.js'
import type {
  SAPUpdate,
  SAPMethodResult,
} from './types.js'

type UpdateType = SAPUpdate['type']
type UpdateOf<T extends UpdateType> = Extract<SAPUpdate, { type: T }>

export interface BotContext<U extends SAPUpdate = SAPUpdate> {
  update: U
  /** Send a text message to the originating session. */
  sendMessage(
    text: string,
    opts?: {
      session_id?: string
      reply_to?: string
      attachments?: unknown[]
      idempotency_key?: string
      usage?: SAPSendMessageUsage
    },
  ): Promise<{ message_id: string }>
}

export interface SAPSendMessageUsage {
  input_tokens: number
  output_tokens: number
  estimated_cost_usd?: number
  model?: string
  provider?: string
}

export interface BotOptions {
  token: string
  webhookSecret: string
  baseURL?: string
  /** Override fetch (mainly for tests). */
  fetchImpl?: typeof fetch
}

type Handler<T extends UpdateType> = (ctx: BotContext<UpdateOf<T>>) => Promise<unknown> | unknown

export interface Bot {
  on<T extends UpdateType>(type: T, handler: Handler<T>): void
  fetch: (req: Request) => Promise<Response>
}

export function createBot(opts: BotOptions): Bot {
  const baseURL = opts.baseURL ?? 'https://api.schat.app'
  const fetchImpl = opts.fetchImpl ?? fetch
  const handlers: Partial<Record<UpdateType, Handler<UpdateType>[]>> = {}

  function on<T extends UpdateType>(type: T, handler: Handler<T>): void {
    const list = (handlers[type] ??= []) as Handler<UpdateType>[]
    list.push(handler as unknown as Handler<UpdateType>)
  }

  async function callMethod(method: string, body: Record<string, unknown>): Promise<SAPMethodResult> {
    const res = await fetchImpl(`${baseURL}/v1/bot/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as SAPMethodResult
    if (!res.ok) {
      throw new Error(
        `Sophon ${method} failed: ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`,
      )
    }
    return json
  }

  const app = new Hono()

  app.post('/sophon-webhook', async (c) => {
    const rawBody = await c.req.text()
    const sig = c.req.header('x-sophon-signature')
    const ts = c.req.header('x-sophon-timestamp')

    const v = verifyWebhookSignature({
      rawBody,
      signatureHeader: sig,
      timestampHeader: ts,
      secret: opts.webhookSecret,
    })
    if (!v.ok) {
      return c.json({ ok: false, error: { code: 'invalid_signature', message: v.reason } }, 401)
    }

    let update: SAPUpdate
    try {
      update = JSON.parse(rawBody) as SAPUpdate
    } catch {
      return c.json({ ok: false, error: { code: 'invalid_json' } }, 400)
    }

    const list = (handlers[update.type] ?? []) as Handler<UpdateType>[]
    if (list.length === 0) {
      return c.json({ method: 'ack' })
    }

    // Build context. For session.message we know session_id; other update
    // types may not have one (installation.* etc.).
    const sessionIdFromUpdate =
      'session' in update && update.session && typeof update.session === 'object'
        ? ((update.session as { id?: string }).id ?? null)
        : null

    const interactionId =
      'interaction_id' in update ? (update as { interaction_id?: string }).interaction_id : undefined

    const ctx: BotContext = {
      update,
      async sendMessage(text, sm = {}) {
        const sid = sm.session_id ?? sessionIdFromUpdate
        if (!sid) {
          throw new Error('sendMessage requires session_id (no session in this update)')
        }
        const idemKey = sm.idempotency_key ?? `${update.update_id}-r${Math.random().toString(36).slice(2, 10)}`
        const body: Record<string, unknown> = {
          session_id: sid,
          text,
          attachments: sm.attachments ?? [],
          idempotency_key: idemKey,
        }
        if (sm.reply_to) body.reply_to = sm.reply_to
        if (interactionId) body.interaction_id = interactionId
        if (sm.usage) body.usage = sm.usage
        const result = await callMethod('sendMessage', body)
        return { message_id: (result.result as { message_id: string }).message_id }
      },
    }

    // Run all handlers; prefer last sync method-style return value if
    // any handler returned one.
    let syncReturn: unknown = undefined
    for (const h of list) {
      const r = await h(ctx)
      if (r) syncReturn = r
    }

    if (syncReturn && typeof syncReturn === 'object' && 'method' in (syncReturn as object)) {
      return c.json(syncReturn as object)
    }
    return c.json({ method: 'ack' })
  })

  return {
    on,
    fetch: app.fetch as (req: Request) => Promise<Response>,
  }
}
