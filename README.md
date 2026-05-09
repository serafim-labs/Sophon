# Sophon

Open-source pieces for [Sophon](https://sophon.at): connector packages, agent skills, and protocol references.

Sophon itself is an iOS chat app for agents you already run. The private app, cloud service, and product code live elsewhere. This repository is only for public connector-facing artifacts.

## What is here

### Packages (npm)

| Package | What it does |
|---|---|
| [`@sophonai/bridge`](packages/openclaw-bridge) | One CLI for connecting local agents (OpenClaw + more) to Sophon over a WebSocket. `npx @sophonai/bridge openclaw`. |
| [`@sophonai/sdk`](packages/sdk) | TypeScript SDK for building webhook-mode SAP agents (`createBot`, signature verification, wire types). |

### Examples

- [`examples/connectors/minimal-typescript`](examples/connectors/minimal-typescript) — smallest useful TypeScript connector.
- [`examples/connectors/minimal-python`](examples/connectors/minimal-python) — smallest useful Python connector.
- [`examples/connectors/minimal-go`](examples/connectors/minimal-go) — smallest useful Go connector.
- [`examples/connectors/stdio-cli`](examples/connectors/stdio-cli) — connector pattern for wrapping a local CLI process.

### Skills

- [`skills/sophon-connector/SKILL.md`](skills/sophon-connector) — agent skill for building a Sophon connector around an existing runtime.

### Protocol

- [`docs/SAP_RFC.md`](docs/SAP_RFC.md) — Sophon Agent Protocol reference.

## Install the connector skill

```sh
npx skills add serafim-labs/Sophon
```

If your agent supports manual skill installation, copy:

```txt
skills/sophon-connector/SKILL.md
```

## Connector model

```txt
iOS app  <->  Sophon Cloud  <->  Connector  <->  Your existing agent runtime
```

The connector holds either:

- a **WebSocket** to Sophon Cloud (use `@sophonai/bridge` — outbound only, works behind NAT), or
- an **HTTP webhook** endpoint (use `@sophonai/sdk` — needs a publicly-reachable URL).

It receives user messages, forwards them to your runtime, then streams replies, tool calls, and approval requests back to Sophon Cloud over the same channel.

## Docs

- Docs: <https://docs.sophon.at>
- Write your own connector: <https://docs.sophon.at/connectors/custom/>
- Connector checklist: <https://docs.sophon.at/connectors/checklist/>
- Wire reference: <https://docs.sophon.at/protocol/wire/>

## Privacy & security

Sophon's chat content is end-to-end encrypted between the iPhone and the bridge — Sophon Cloud stores ciphertext only.

- Privacy Policy: <https://sophon.at/privacy>
- Terms of Use: <https://sophon.at/terms>
- Security details: <https://docs.sophon.at/product/security-privacy/>

## License

Apache-2.0 — see [LICENSE](LICENSE).
