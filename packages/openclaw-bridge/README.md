# @sophon/openclaw-bridge

Bridge a self-hosted OpenClaw gateway through Sophon's SAP.

You run OpenClaw on your Mac. Sophon opens a secure bridge to it, so the iOS app can push messages to your local agent and receive streaming replies back. No public URL needed.

## Install + run

```sh
npx @sophonai/openclaw \
  --openclaw-url ws://localhost:8089 \
  --openclaw-token <your_openclaw_secret>
```

On first run the CLI opens your browser:

1. Sign in with Google.
2. Confirm **Pair this computer**.
3. Return to the terminal.

The CLI saves a scoped Sophon bridge token in `~/.config/sophon/credentials.json` and reuses it on later runs. The browser never receives the bridge token directly; it only confirms the pairing intent while the CLI polls Sophon for the token.

For SSH/headless machines:

```sh
npx @sophonai/openclaw \
  --manual-pair \
  --openclaw-url ws://localhost:8089 \
  --openclaw-token <your_openclaw_secret>
```

That prints a 7-letter code you can claim from the Sophon iOS app.

## Useful flags

```sh
--openclaw-url <ws-url>      default ws://localhost:8089
--openclaw-token <token>     OpenClaw operator token
--sophon-base <url>          default https://api.sophon.at
--sophon-token <token>       skip login, use this bridge token
--manual-pair                headless fallback, print iOS code
--logout                     delete saved Sophon credentials
--host-label <name>          visible in Sophon's host list
--verbose                    log wire events
```

## What works

- Browser Google sign-in + auto-pairing
- Saved scoped bridge credentials
- WebSocket transport to Sophon (`wss://api.sophon.at/v1/bridge/ws`)
- Operator-role handshake to OpenClaw
- `chat.send` translation
- Streaming `text_delta` → SAP `sendMessageDelta`
- Tool cards and approvals forwarding
- Auto-reconnect with exponential backoff

## How it works

```
   ┌──────────────────────────────────────────────────────────────┐
   │  Your Mac — `npx @sophonai/openclaw`                         │
   │  ┌─ Sophon side ──────┐         ┌─ OpenClaw side ─────────┐  │
   │  │ wss://api.sophon.at │  pushes │ ws://localhost:8089     │  │
   │  │ /v1/bridge/ws       │ ──────→ │ role: operator           │  │
   │  │ Bearer inst_…       │         │ token: <gateway secret>  │  │
   │  └─────────────────────┘         └──────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
                │                                    │
                ▼                                    ▼
       Sophon platform                        Your local OpenClaw
       (api.sophon.at)                        (your model/tools)
```

The bridge is a stateless translator. Sophon owns history, OpenClaw owns inference. Restart it any time; sessions resume by their `session_id`.

## License

Apache-2.0
