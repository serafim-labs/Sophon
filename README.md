# Sophon

Open-source pieces for Sophon: connector examples, agent skills, and protocol references.

Sophon itself is an iOS chat app for agents you already run. The private app, cloud service, and product code live elsewhere. This repository is only for public connector-facing artifacts.

## What is here

- `skills/sophon-connector/SKILL.md` — an agent skill for building a Sophon connector around an existing runtime.
- `examples/connectors/minimal-typescript` — smallest useful TypeScript connector example.
- `examples/connectors/minimal-python` — smallest useful Python connector example.
- `examples/connectors/minimal-go` — smallest useful Go connector example.
- `examples/connectors/stdio-cli` — connector pattern for wrapping a local CLI process.
- `packages/openclaw-bridge` — reference OpenClaw connector source.
- `docs/SAP_RFC.md` — Sophon Agent Protocol reference.

## Install the skill

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

The connector holds a WebSocket to Sophon Cloud, receives user messages, forwards them to your runtime, then streams replies, tool calls, and approval requests back through the bridge API.

## Docs

- Docs: https://docs.sophon.at
- Write your own connector: https://docs.sophon.at/connectors/custom/
- Connector checklist: https://docs.sophon.at/connectors/checklist/
- Wire reference: https://docs.sophon.at/protocol/wire/

## License

Apache-2.0
