---
name: sophon-connector
description: Build a Sophon connector that exposes an existing agent runtime in the Sophon iOS app.
summary: Build a Sophon connector that exposes an existing agent runtime in the Sophon iOS app.
version: 0.1.0
---

# Sophon Connector Skill

Use this skill when the user wants to connect an existing agent runtime to Sophon.
Do not teach them how to build a general-purpose agent from scratch. Your job is to build the bridge layer between Sophon and the runtime they already have.

## Goal

Create a long-running connector process that:

1. Authenticates with a Sophon bridge token.
2. Opens `wss://api.sophon.at/v1/bridge/ws`.
3. Receives `session.message` updates.
4. Sends the message into the user's existing agent runtime.
5. Streams text back through `/v1/bridge/sendMessageDelta`.
6. Finalizes through `/v1/bridge/sendMessageEnd`.
7. Mirrors tool calls and approval requests when the runtime supports them.

## First questions

Ask only for details that block implementation:

- What runtime are we wrapping? Examples: local HTTP server, stdio CLI, MCP server, Python function, hosted API.
- How do we send it a user message?
- How does it stream output, if at all?
- Does it expose tool calls, logs, or approval events?
- Where should the connector run?

If the repo already contains the runtime, inspect it before asking.

## Implementation shape

Prefer TypeScript unless the repo is clearly Python or another language.

Recommended files:

```text
connector/
  package.json
  src/index.ts
  src/sophon.ts
  src/runtime.ts
  .env.example
```

Environment:

```bash
SOPHON_TOKEN=inst_...:s_live_...
SOPHON_BASE=https://api.sophon.at
```

## Wire requirements

### WebSocket

Connect:

```text
wss://api.sophon.at/v1/bridge/ws
Authorization: Bearer $SOPHON_TOKEN
```

Handle frames:

- `ready`: store installation id for logs.
- `ping`: reply with `pong` within 10 seconds.
- `update`: process and ack with `ack` after durable handling.

Only start an agent turn for:

```json
{ "type": "session.message" }
```

### Message lifecycle

For every inbound user message:

1. `POST /v1/bridge/sendMessage` to create the assistant bubble.
2. Stream chunks with `POST /v1/bridge/sendMessageDelta`.
3. Finish with `POST /v1/bridge/sendMessageEnd`.

Use stable idempotency keys. Do not use timestamps alone.

### Tools

If the runtime emits tools, map them to:

- `/v1/bridge/createTask`
- `/v1/bridge/updateTask`
- `/v1/bridge/finishTask`

Keep `task_id` stable for retries.

### Approvals

If the runtime needs human approval:

1. Create an approval request through the bridge API.
2. Pause runtime execution.
3. Wait for `approval.resolved` from the WebSocket.
4. Resume or deny the runtime action.

Never auto-approve destructive actions.

## UX rules

- Name the connector after the runtime, not after Sophon.
- Store tokens in local config or env, never in source.
- Print a clear connected state.
- Print the Sophon installation id after pairing.
- Recover cleanly on WebSocket reconnect.

## Testing checklist

Before calling the connector done:

- Start connector with an invalid token and confirm it fails clearly.
- Start connector with a valid token and confirm `ready` arrives.
- Send one iOS message and confirm a streamed response.
- Kill and restart connector and confirm it reconnects.
- If tools exist, confirm tool cards render.
- If approvals exist, confirm the runtime pauses until iOS answers.

## References

- Connector walkthrough: https://docs.sophon.at/connectors/custom/
- Wire reference: https://docs.sophon.at/protocol/wire/
- Streaming model: https://docs.sophon.at/protocol/streaming/
- Tools and approvals: https://docs.sophon.at/protocol/tools-and-approvals/
- OpenClaw bridge reference: https://docs.sophon.at/connectors/openclaw/
