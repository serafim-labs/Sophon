# Minimal Python connector

A tiny Sophon connector written in Python. It opens the Sophon bridge WebSocket, receives iOS messages, and streams an echo response back to the app.

```txt
iOS app -> Sophon Cloud -> this Python connector -> echo response -> Sophon Cloud -> iOS app
```

## Requirements

- Python 3.11+
- A Sophon installation token, shaped like:

```txt
inst_...:s_live_...
```

## Run it

From the repository root:

```sh
cd examples/connectors/minimal-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
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
python connector.py
```

When it connects, send a message from the Sophon iOS app. You should see a streamed assistant response like:

```txt
Echo from Python connector: hello
```

## Code map

- `connector.py` connects to Sophon, handles WebSocket frames, and streams the echo response.
- `requirements.txt` lists the `aiohttp` and `websockets` dependencies.
- `.env.example` lists the required environment variables.

## Production notes

Before adapting this into a real connector, add reconnect/backoff, durable update offsets, stable idempotency storage, structured logs, and runtime-specific error handling.
