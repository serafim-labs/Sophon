# Stdio CLI connector

A Sophon connector pattern for wrapping an existing command-line agent.

The connector receives a user message from Sophon, writes that message to `AGENT_COMMAND` on stdin, streams stdout back to iOS, and finalizes the assistant message when the process exits.

```txt
iOS app -> Sophon Cloud -> this connector -> local CLI agent
                                      <- stdout stream <-
```

Use this when your runtime already works as a terminal command, for example:

- a local coding agent CLI
- a Python script
- a shell pipeline
- a wrapper around a model API
- a local binary that reads stdin and writes stdout

## What it demonstrates

- Authenticating with a Sophon installation token.
- Opening the bridge WebSocket at `/v1/bridge/ws`.
- Handling `ping` frames with `pong`.
- Acknowledging `update` frames after receipt.
- Starting a subprocess for each `session.message`.
- Passing the user message to the subprocess over stdin.
- Streaming subprocess stdout through `/v1/bridge/sendMessageDelta`.
- Completing the iOS assistant bubble with `/v1/bridge/sendMessageEnd`.
- Logging subprocess stderr locally.

It intentionally keeps process orchestration simple. For production, you probably want a long-running runtime process, a job queue, cancellation, timeouts, and durable resume state.

## Requirements

- Node.js 20+
- A Sophon installation token, shaped like:

```txt
inst_...:s_live_...
```

- A CLI command that accepts the user message on stdin and writes assistant text to stdout.

## Run with the included mock agent

From the repository root:

```sh
npm install
cp examples/connectors/stdio-cli/.env.example examples/connectors/stdio-cli/.env
```

Edit `.env`:

```sh
SOPHON_TOKEN=inst_...:s_live_...
SOPHON_BASE=https://api.sophon.at
AGENT_COMMAND=node ./mock-agent.js
```

Then run:

```sh
cd examples/connectors/stdio-cli
npm run dev
```

When you send a message from the Sophon iOS app, the included `mock-agent.js` reads it from stdin and prints a short streamed response.

## Wrap your own CLI

Set `AGENT_COMMAND` to your runtime:

```sh
AGENT_COMMAND="python3 ./agent.py"
AGENT_COMMAND="node ./my-agent.js"
AGENT_COMMAND="my-agent --model local"
```

The command must:

1. read the user message from stdin
2. write assistant text to stdout
3. write logs/errors to stderr
4. exit when the turn is complete

Example Python runtime:

```python
import sys

message = sys.stdin.read()
print(f"You said: {message}")
```

## Code map

- `src/index.ts` connects to Sophon and bridges WebSocket updates into subprocess turns.
- `mock-agent.js` is a tiny fake CLI runtime for local testing.
- `.env.example` lists the required environment variables.
- `package.json` contains `dev`, `build`, and `lint` scripts.

## Production notes

Before adapting this into a real connector, add:

- subprocess timeout and cancellation
- one-turn-at-a-time locking per session
- reconnect with exponential backoff
- durable update offsets before `ack`
- stable idempotency keys that survive process restarts
- better handling for non-zero exit codes
- stderr capture into connector logs or task cards
- approval mapping if your CLI can request human confirmation

## Read next

- Write your own connector: https://docs.sophon.at/connectors/custom/
- Connector checklist: https://docs.sophon.at/connectors/checklist/
- Wire reference: https://docs.sophon.at/protocol/wire/
- Tools and approvals: https://docs.sophon.at/protocol/tools-and-approvals/
