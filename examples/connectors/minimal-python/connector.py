import asyncio
import json
import os
from typing import Any

import aiohttp
import websockets

TOKEN = os.environ.get("SOPHON_TOKEN")
BASE = os.environ.get("SOPHON_BASE", "https://api.sophon.at").rstrip("/")

if not TOKEN:
    raise RuntimeError("SOPHON_TOKEN is required")


def ws_url() -> str:
    if BASE.startswith("https://"):
        return "wss://" + BASE[len("https://") :] + "/v1/bridge/ws"
    if BASE.startswith("http://"):
        return "ws://" + BASE[len("http://") :] + "/v1/bridge/ws"
    raise RuntimeError("SOPHON_BASE must start with http:// or https://")


async def post(session: aiohttp.ClientSession, path: str, body: dict[str, Any]) -> dict[str, Any]:
    async with session.post(
        BASE + path,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        json=body,
    ) as res:
        try:
            payload = await res.json()
        except aiohttp.ContentTypeError:
            payload = None

        if res.status >= 400 or (isinstance(payload, dict) and payload.get("ok") is False):
            raise RuntimeError(f"{path} failed: {res.status} {payload}")

        if isinstance(payload, dict):
            result = payload.get("result")
            if isinstance(result, dict):
                return result
            return payload
        return {}


def chunks(text: str, size: int = 24) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


async def respond(session: aiohttp.ClientSession, update: dict[str, Any]) -> None:
    interaction_id = update["interaction_id"]
    message = update.get("payload", {}).get("message", {})
    text = message.get("text", "")
    reply = f"Echo from Python connector: {text}"

    created = await post(
        session,
        "/v1/bridge/sendMessage",
        {
            "session_id": update["session_id"],
            "interaction_id": interaction_id,
            "text": "",
            "idempotency_key": f"{interaction_id}:message",
        },
    )
    message_id = created.get("message_id") or created.get("id")

    for index, delta in enumerate(chunks(reply)):
        await post(
            session,
            "/v1/bridge/sendMessageDelta",
            {
                "message_id": message_id,
                "delta": delta,
                "idempotency_key": f"{interaction_id}:delta:{index}",
            },
        )

    await post(
        session,
        "/v1/bridge/sendMessageEnd",
        {
            "message_id": message_id,
            "text": reply,
            "finish_reason": "stop",
            "idempotency_key": f"{interaction_id}:end",
        },
    )


async def main() -> None:
    async with aiohttp.ClientSession() as session:
        async with websockets.connect(
            ws_url(),
            additional_headers={"Authorization": f"Bearer {TOKEN}"},
        ) as ws:
            print("Sophon Python connector connected")
            async for raw in ws:
                frame = json.loads(raw)
                if frame.get("type") == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                    continue
                if frame.get("type") != "update":
                    continue

                update = frame["update"]
                await ws.send(json.dumps({"type": "ack", "up_to_update_id": update["update_id"]}))
                if update.get("type") == "session.message":
                    await respond(session, update)


if __name__ == "__main__":
    asyncio.run(main())
