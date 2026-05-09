# @sophonai/sdk

TypeScript SDK for building [Sophon Agent Protocol](https://docs.sophon.at/protocol/) (SAP) connectors and webhook agents.

Sophon is an iOS chat app that talks to AI assistants you run yourself. SAP is the wire format between Sophon Cloud and your agent. This SDK wraps the wire boundary so you only deal with typed events and helpers, not raw JSON-over-HTTP / WebSocket.

```sh
npm install @sophonai/sdk
```

## Webhook bot — quick start

For shared agents that receive `session.message` events as HTTP webhooks:

```ts
import { createBot } from '@sophonai/sdk'
import { serve } from '@hono/node-server'

const bot = createBot({
  token: process.env.SOPHON_TOKEN!,
  webhookSecret: process.env.SOPHON_WEBHOOK_SECRET!,
  baseURL: 'https://api.sophon.at',
})

bot.on('session.message', async (ctx) => {
  await ctx.sendMessage(`echo: ${ctx.message.text}`)
})

serve({ fetch: bot.fetch, port: 3030 })
```

The bot:
- Verifies every incoming webhook signature (`t=…,v1=…` header) before invoking your handler — bad signatures get rejected.
- Hands you a typed `BotContext` with `update`, `message`, and `sendMessage` helpers.
- Calls Sophon Cloud's bot APIs with your bearer token transparently.

## What's in here

| Export | Use |
|---|---|
| `createBot` | Build a Hono-based webhook handler — pass to `serve({ fetch })`. |
| `verifyWebhookSignature` | Drop-in HMAC-SHA256 verifier (Stripe-compat) when you don't want the full bot wrapper. |
| `SAPUpdate`, `SAPSession`, `SAPInstallation`, `SAPMessageContext` | Wire types you'll see in webhook bodies. |
| `SAPSendMessageUsage` | Typed usage counters for `sendMessage` (tokens, cost, …). |

## Signature verification — without the bot wrapper

If you have an existing HTTP framework, plug in just the verifier:

```ts
import { verifyWebhookSignature } from '@sophonai/sdk'

const result = verifyWebhookSignature({
  rawBody: await req.text(),                          // RAW body — before JSON.parse
  signatureHeader: req.headers.get('x-sophon-sig'),
  timestampHeader: req.headers.get('x-sophon-ts'),
  secret: process.env.SOPHON_WEBHOOK_SECRET!,
})

if (!result.ok) return new Response('bad sig', { status: 401 })
```

Pass the **raw** request body, not a re-serialised JSON. Any byte difference (whitespace, key order) fails verification — that's the point.

## Wire model

```
iOS app  <->  Sophon Cloud  <->  Your bot (HTTP webhook)
```

Sophon Cloud delivers JSON-encoded `SAPUpdate` events to your webhook endpoint. Your handler can call back into the cloud (`sendMessage`, `requestApproval`, …) using the bearer token from `createBot`.

For lower-level details — wire shapes, retry semantics, idempotency — see [the protocol docs](https://docs.sophon.at/protocol/).

## Differences from `@sophonai/bridge`

| | `@sophonai/sdk` | `@sophonai/bridge` |
|---|---|---|
| Audience | Backend bot authors | Local-tool wrappers (OpenClaw, …) |
| Transport | HTTP webhook (server receives) | WebSocket (your machine connects out) |
| Network | Public-facing endpoint | Outbound only — no inbound port |
| State | Stateless per request | Persistent connection |

If your agent runs on a developer's laptop behind NAT, you want the bridge. If it runs on a publicly-reachable server (Vercel, Fly, your own VPS), you want this SDK.

## License

Apache-2.0 — see [LICENSE](../../LICENSE).

## Contributing

Issues + PRs welcome at <https://github.com/serafim-labs/sophon/issues>. The SDK source is ~3 files (`bot.ts`, `signature.ts`, `types.ts`); please keep it small and dependency-light.
