# Minimal Go connector

A tiny Sophon connector written in Go. It opens the Sophon bridge WebSocket, receives iOS messages, and streams an echo response back to the app.

```txt
iOS app -> Sophon Cloud -> this Go connector -> echo response -> Sophon Cloud -> iOS app
```

## Requirements

- Go 1.22+
- A Sophon installation token, shaped like:

```txt
inst_...:s_live_...
```

## Run it

From the repository root:

```sh
cd examples/connectors/minimal-go
cp .env.example .env
go mod download
```

Edit `.env`:

```sh
SOPHON_TOKEN=inst_...:s_live_...
SOPHON_BASE=https://api.sophon.at
```

Load the variables and start the connector:

```sh
set -a
source .env
set +a
go run .
```

When it connects, send a message from the Sophon iOS app. You should see a streamed assistant response like:

```txt
Echo from Go connector: hello
```

## Code map

- `main.go` connects to Sophon, handles WebSocket frames, and streams the echo response.
- `go.mod` declares the single WebSocket dependency.
- `.env.example` lists the required environment variables.

## Production notes

Before adapting this into a real connector, add reconnect/backoff, durable update offsets, stable idempotency storage, structured logs, and runtime-specific error handling.
