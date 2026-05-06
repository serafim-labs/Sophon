# Minimal TypeScript connector

A tiny Sophon connector that echoes iOS messages back through the Sophon bridge API.

Use this example when you want the smallest possible connector that proves the full Sophon loop works before wiring a real runtime.

```txt
iOS app -> Sophon Cloud -> this connector -> echo response -> Sophon Cloud -> iOS app
```

## What it demonstrates

- Authenticating with a Sophon installation token.
- Opening the bridge WebSocket at `/v1/bridge/ws`.
- Handling `ping` frames with `pong`.
- Acknowledging `update` frames after receipt.
- Responding only to `session.message` updates.
- Creating an assistant message with `/v1/bridge/sendMessage`.
- Streaming text with `/v1/bridge/sendMessageDelta`.
- Finishing the message with `/v1/bridge/sendMessageEnd`.

It intentionally does not include tools, approvals, persistence, or reconnect logic. See `packages/openclaw-bridge` for a more complete reference connector.

## Requirements

- Node.js 20+
- A Sophon installation token, shaped like:

```txt
inst_...:s_live_...
```

You can get a token by pairing a connector from the Sophon iOS app or by using the OpenClaw connector flow documented at https://docs.sophon.at/connectors/openclaw/.

## Run it

From the repository root:

```sh
npm install
cp examples/connectors/minimal-typescript/.env.example examples/connectors/minimal-typescript/.env
```

Edit `.env`:

```sh
SOPHON_TOKEN=inst_...:s_live_...
SOPHON_BASE=https://api.sophon.at
```

Then run:

```sh
cd examples/connectors/minimal-typescript
npm run dev
```

When it connects, send a message from the Sophon iOS app. You should see a streamed assistant response like:

```txt
Echo from connector: hello
```

## Code map

- `src/index.ts` connects to Sophon, handles frames, and sends the echo response.
- `.env.example` lists the required environment variables.
- `package.json` contains `dev`, `build`, and `lint` scripts.

## Production notes

Before adapting this into a real connector, add:

- reconnect with exponential backoff
- durable update offsets before `ack`
- stable idempotency keys that survive process restarts
- request logging with interaction IDs
- token storage outside source control
- runtime-specific error handling

## Read next

- Write your own connector: https://docs.sophon.at/connectors/custom/
- Connector checklist: https://docs.sophon.at/connectors/checklist/
- Wire reference: https://docs.sophon.at/protocol/wire/
- Idempotency and resume: https://docs.sophon.at/protocol/idempotency/
