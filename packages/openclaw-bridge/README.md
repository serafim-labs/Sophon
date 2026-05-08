# @sophonai/bridge

One CLI to connect local agents to [Sophon](https://sophon.at). Each subcommand handles a specific upstream tool — auto-detects whether it's installed, offers to install it if not, then bridges it to the Sophon iOS app over a secure WebSocket.

## Quick start

```sh
npx @sophonai/bridge openclaw
```

That single command:

1. Checks whether OpenClaw is installed — offers to run `npm install -g openclaw@latest` if not.
2. Reads `~/.openclaw/openclaw.json` for the gateway URL + token. *(If it's the very first install, the CLI prints `openclaw start` for you to run once and re-invoke — see below.)*
3. Opens your browser to sign in with Sophon and **Pair this computer**.
4. Streams messages between the iOS app and your local OpenClaw.

When both ends are connected you'll see:

```
[ready] sophon=connected openclaw=connected installation=inst_…
bridge running — Ctrl-C to stop
```

The `[ready]` line is the deterministic "we're live" milestone — agents driving this CLI should wait for it before calling the bridge usable. Sophon credentials are saved in `~/.config/sophon/credentials.json` (mode `0600`) and reused on every subsequent run.

### First-run on a fresh Mac

If neither OpenClaw nor its gateway have ever run on this machine, the path is:

```sh
npx @sophonai/bridge openclaw    # installs OpenClaw if missing, then asks you to run:
openclaw start                   # initializes ~/.openclaw + starts the gateway
npx @sophonai/bridge openclaw    # now bridges to Sophon
```

We don't auto-run `openclaw start` because it spawns a long-lived process best owned by the user.

### Headless / SSH

```sh
npx @sophonai/bridge openclaw --manual-pair
```

Prints a 7-letter code to claim from the Sophon iOS app. The CLI auto-falls-back to this mode when no TTY is detected (CI, `ssh user@host npx …`, etc.) — you'll see `→ no TTY detected — using manual pairing`.

## Subcommands

| Command | Purpose |
|---|---|
| `openclaw` | Bridge a local OpenClaw gateway through Sophon |
| `doctor [connector]` | Preflight checklist — checks binary, gateway, token, WS reachability, Sophon API, saved credentials |
| `status` | Print where credentials live + which installation is paired |
| `--version` | Print package version |
| `--help` | Print usage |

`doctor` does no network mutations and exits non-zero if any required check fails — perfect for CI gates and agents.

```sh
$ npx @sophonai/bridge doctor

@sophonai/bridge doctor — openclaw

  ✓ openclaw binary on PATH — /usr/local/bin/openclaw
  ✓ gateway initialized — /Users/me/.openclaw/openclaw.json
  ✓ openclaw operator token — from /Users/me/.openclaw/openclaw.json
  ✓ openclaw gateway reachable — ws://localhost:18789
  ✓ sophon API reachable — https://api.sophon.at (200 OK)
  ✓ sophon credentials saved — /Users/me/.config/sophon/credentials.json (installation=inst_…)

✓ all required checks passed
```

## Connectors

| ID | Status | What it bridges |
|---|---|---|
| `openclaw` | shipped | Local OpenClaw gateway (WebSocket) |
| `claude-code` | planned | Anthropic Claude Code CLI |
| `hermes` | planned | Hermes self-hosted agents |

Run `npx @sophonai/bridge <connector> --help` for connector-specific flags.

## openclaw flags

```sh
--openclaw-url <ws-url>      override autodetect (default ws://localhost:18789)
--openclaw-token <token>     override autodetect from ~/.openclaw/
--sophon-base <url>          default https://api.sophon.at
--sophon-token <token>       skip login, use this bridge token
--manual-pair                headless fallback, print iOS code
--logout                     delete saved Sophon credentials
--host-label <name>          visible in Sophon's host list
--yes, -y                    non-interactive: auto-accept install prompts
--verbose                    log wire events
```

Env equivalents: `OPENCLAW_URL`, `OPENCLAW_TOKEN`, `OPENCLAW_STATE_DIR`, `SOPHON_BASE_URL`, `SOPHON_BOT_TOKEN`, `SOPHON_HOST_LABEL`, `SOPHON_MANUAL_PAIR=1`, `SOPHON_YES=1`, `SOPHON_CONFIG_DIR`, `VERBOSE=1`.

## Exit codes

Agents and CI scripts can branch on these:

| Code | Meaning |
|---|---|
| `0` | clean exit |
| `1` | runtime error (unexpected) |
| `2` | bad usage — unknown flag, unknown subcommand, malformed args |
| `10` | OpenClaw is not installed on this machine |
| `11` | OpenClaw installed but local gateway not initialized |
| `12` | OpenClaw gateway unreachable on the configured WS URL |
| `13` | Could not resolve an OpenClaw operator token |
| `20` | Sophon API unreachable on the configured base URL |
| `21` | Pairing window timed out (no claim within ~120s) |
| `22` | Pairing code expired before claim |

Stdout is reserved for machine-readable output (`--version`, `--json` events). All UX, prompts, and progress go to **stderr** — pipe accordingly.

## JSON events (`--json`)

Pass `--json` (or set `SOPHON_JSON=1`) to receive a stable NDJSON stream on stdout — one JSON object per line, suitable for piping into `jq`, agents, or supervisors. Human stderr output is suppressed; only fatal panics still write there.

```sh
$ npx @sophonai/bridge --json openclaw --yes
{"event":"starting","ts":"…","connector":"openclaw","sophon_base":"https://api.sophon.at","host_label":"my-mac"}
{"event":"openclaw_token_resolved","ts":"…","source":"/Users/me/.openclaw/openclaw.json"}
{"event":"pairing_started","ts":"…","connector":"openclaw","code":"ABCDEFG","expires_at":1746646800000,"ttl_sec":120,"browser_url":"https://api.sophon.at/v1/pairing/redeem?code=…","mode":"browser"}
{"event":"pairing_browser_opened","ts":"…","browser_url":"…"}
{"event":"pairing_waiting","ts":"…","elapsed_sec":15,"remaining_sec":105}
{"event":"pairing_claimed","ts":"…","installation_id":"inst_…"}
{"event":"openclaw_connected","ts":"…","url":"ws://localhost:18789"}
{"event":"sophon_connected","ts":"…","base_url":"https://api.sophon.at"}
{"event":"ready","ts":"…","sophon_base":"https://api.sophon.at","openclaw_url":"ws://localhost:18789","installation_id":"inst_…"}
```

### Event catalog

| Event | When it fires | Stable fields |
|---|---|---|
| `starting` | run begins | `connector`, `sophon_base`, `host_label` |
| `openclaw_install_required` | binary not on PATH | `options[]` |
| `openclaw_install_done` | install succeeded | `path` |
| `openclaw_token_resolved` | gateway token autodetected | `source` |
| `pairing_started` | pairing window opened | `code`, `expires_at`, `ttl_sec`, `browser_url`, `mode` |
| `pairing_browser_opened` | system browser launched | `browser_url` |
| `pairing_waiting` | every 15 s while polling | `elapsed_sec`, `remaining_sec` |
| `pairing_claimed` | iOS app accepted the code | `installation_id` |
| `openclaw_connected` | local WS handshake done | `url` |
| `sophon_connected` | first Sophon WS open | `base_url` |
| `ready` | both sides connected | `sophon_base`, `openclaw_url`, `installation_id` |
| `shutdown` | clean exit | `reason`, `signal?` |
| `error` | recoverable / fatal failure | `code`, plus context fields |
| `doctor_check` | one per `doctor` check | `name`, `status`, `detail`, `hint` |
| `doctor_summary` | end of `doctor` | `ok`, `pass`, `fail`, `warn`, `info` |
| `status` | `status` subcommand | `credentials_file`, `sophon_base`, `paired`, `installation_id`, `paired_at` |
| `help` | `--help` in JSON mode | `package`, `connectors[]`, `global_*` |
| `version` | `--version` in JSON mode | `version` |

`error.code` mirrors the exit-code names: `openclaw_not_installed`, `openclaw_not_initialized`, `openclaw_unreachable`, `openclaw_no_token`, `pairing_timeout`, `pairing_expired`, `pairing_failed`, `unknown_subcommand`, `no_doctor`, `fatal`. The `ready` event is the safe milestone for an agent to consider the bridge usable; everything before it is setup / handshake.

In `--json` mode interactive prompts are skipped, so:
- pass `--yes` if a fresh OpenClaw install may be needed,
- the CLI auto-falls-back to `--manual-pair` (no browser flow), so monitor `pairing_started.code` and surface it to the user.

## How it works

```
   ┌──────────────────────────────────────────────────────────────┐
   │  Your Mac — `npx @sophonai/bridge openclaw`                  │
   │  ┌─ Sophon side ──────┐         ┌─ OpenClaw side ─────────┐  │
   │  │ wss://api.sophon.at │  pushes │ ws://localhost:18789    │  │
   │  │ /v1/bridge/ws       │ ──────→ │ role: operator           │  │
   │  │ Bearer <bot-token>  │         │ token: <gateway secret>  │  │
   │  └─────────────────────┘         └──────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
                │                                    │
                ▼                                    ▼
       Sophon platform                        Your local OpenClaw
       (api.sophon.at)                        (your model/tools)
```

The bridge is a stateless translator. Sophon owns history, OpenClaw owns inference. Restart it any time; sessions resume by `session_id`.

## Building your own bridge

Writing a custom bridge for a new tool? See [`@sophonai/bridge-core`](https://www.npmjs.com/package/@sophonai/bridge-core) (coming soon) — the SDK we use to ship the bridges in this CLI. Or open a PR to add your connector here.

If you're contributing a built-in connector to this repo, the architectural map + `ConnectorRunner` contract live in [`docs/BRIDGE_CLI.md`](../../../docs/BRIDGE_CLI.md).

## License

Apache-2.0
