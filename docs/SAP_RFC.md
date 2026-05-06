# Sophon Agent Protocol (SAP) — RFC v0.1

> **Status:** Draft v0.1 · **Date:** 2026-04-30 · **License:** Apache 2.0 (when published)
>
> Spec for the wire protocol between Sophon backend and any agent. iOS-app and agents speak SAP through the backend; backend is the routing fabric.
>
> **Companions:** [`PLATFORM_PLAN.md`](PLATFORM_PLAN.md) (strategy) · [`SAP_ABSTRACTIONS.md`](SAP_ABSTRACTIONS.md) (visual mapping) · [`CUSTOM_AGENT_GUIDE.md`](CUSTOM_AGENT_GUIDE.md) (DX walkthrough)

---

## Table of contents

1. [Conventions](#1-conventions)
2. [Architecture overview](#2-architecture-overview)
3. [Authentication & tokens](#3-authentication--tokens)
4. [Transports](#4-transports)
5. [Wire format basics](#5-wire-format-basics)
6. [Updates (backend → agent)](#6-updates-backend--agent)
7. [Methods (agent → backend)](#7-methods-agent--backend)
8. [Streaming responses (SSE)](#8-streaming-responses-sse)
9. [Sessions & messages](#9-sessions--messages)
10. [Tool calls](#10-tool-calls)
11. [Approvals (HITL)](#11-approvals-hitl)
12. [Memory](#12-memory)
13. [Device capabilities](#13-device-capabilities)
14. [Tasks (long-running)](#14-tasks-long-running)
15. [Errors](#15-errors)
16. [Rate limits](#16-rate-limits)
17. [Idempotency](#17-idempotency)
18. [Resumable streams & cancellation](#18-resumable-streams--cancellation)
19. [Agent manifest & registration](#19-agent-manifest--registration)
19a. [Observability](#19a-observability)
20. [Security](#20-security)
21. [Versioning & deprecation](#21-versioning--deprecation)
22. [Open questions](#22-open-questions)
23. [Examples](#23-examples)

---

## 1. Conventions

- Keywords **MUST**, **SHOULD**, **MAY** follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).
- All string values are UTF-8. Backend NFKC-normalizes user-supplied text before forwarding.
- Timestamps are integer Unix milliseconds unless explicitly marked otherwise.
- All identifiers (agent IDs, session IDs, etc.) are opaque strings. Agents **MUST NOT** parse their internal structure beyond what's documented.
- JSON is canonical wire format. Field names are `snake_case`.
- HTTP base URL: `https://api.sophon.at/v1` (production). `Authorization: Bearer <token>` on every request.

### 1.1 Identifier formats

| Kind | Format | Example |
|---|---|---|
| Agent ID | `agt_<12 hex>` | `agt_8f3kz2aq` |
| Bot token | `<agent_id>:s_<env>_<32 base62>` | `agt_8f3kz2aq:s_live_abc123def456...` |
| Installation ID | `inst_<16 base62>` | `inst_q9w8e7r6t5y4u3i2` |
| Session ID | `ses_<16 base62>` | `ses_a1b2c3d4e5f6g7h8` |
| Message ID | `msg_<16 base62>` | `msg_x9y8z7w6v5u4t3s2` |
| Update ID | monotonic uint64 (per-agent) | `1234567` |
| Interaction ID | `int_<16 base62>` | `int_p0o9i8u7y6t5r4e3` |
| Task ID | `task_<16 base62>` | `task_m1n2b3v4c5x6z7l8` |
| Approval ID | `apr_<16 base62>` | `apr_q1w2e3r4t5y6u7i8` |
| Tool call ID | `tc_<12 base62>` | `tc_zxc987qwe654` |
| Capability request ID | `dcr_<16 base62>` | `dcr_l9k8j7h6g5f4d3s2` |

### 1.2 Glossary

- **Agent** — a software entity (bot) that participates in chats with users. Has a stable handle (`@cooking_helper`) and bot token.
- **Connector** — agent runtime + the SAP-translation layer. Runs on our infra (managed), user's machine (npx bridges), or dev's server (third-party).
- **User** — Sophon end user, signed in with Google. Has installations.
- **Installation** — instance of an agent installed by a user. Carries permissions and per-installation state. Identified by `installation_id`.
- **Session** — chat thread between one user and one agent (or, in v2, multiple agents). One installation may have many sessions.
- **Update** — message from backend to agent (incoming event). Has `update_id`.
- **Method** — request from agent to backend (action).
- **Interaction** — single user-message → agent-response cycle, identified by `interaction_id`. Used for defer-then-followup.

---

## 2. Architecture overview

```
   user iOS                Sophon Backend                  Agent runtime
   ┌──────┐                  ┌──────────┐                    ┌────────┐
   │      │  ── send ───▶    │          │  ── update ──▶     │        │
   │ App  │                  │  Router  │                    │   Bot  │
   │      │  ◀─ stream ──    │          │  ◀── method ──     │        │
   └──────┘                  └──────────┘                    └────────┘
              SAP                                  SAP
```

**iOS ↔ backend** uses internal API (not part of SAP — see existing iOS plans). **Backend ↔ agent** is what this RFC specifies.

The backend never talks to the agent runtime directly in code form — it only sends/receives SAP frames. This keeps agents free to be written in any language (TS, Python, Go, Rust) and run anywhere.

---

## 3. Authentication & tokens

### 3.1 Token format

```
agt_<12 hex>:s_<env>_<32+ base62>
```

- `agt_<12 hex>` — agent ID, identifies the agent
- `s_<env>_…` — secret part. `env` is `live` or `test`
- Total length ≥ 50 chars

Example: `agt_8f3kz2aq:s_live_AbC123DeF456GhI789JkL012MnO345PqR678`

### 3.2 Bearer authentication

All HTTP methods called by the agent **MUST** include:

```http
Authorization: Bearer <bot_token>
```

Tokens **MUST NOT** be placed in URL paths or query strings. Backend rejects URL-embedded tokens with `400 invalid_token_location`.

### 3.3 Token scopes

Each token has a scope set, declared at token creation:

| Scope | Allows |
|---|---|
| `send` | sending messages, tool calls, approvals (default required) |
| `read_history` | reading session message history beyond context window |
| `manage_agent` | updating agent metadata, declaring tools |
| `read_memory` | reading shared memory namespaces (subject to user grants) |
| `write_memory` | writing shared memory (subject to user grants) |
| `device_capability` | requesting device tools (subject to user grants) |
| `admin` | revoking own tokens, deleting agent |

Reduced scope = reduced blast radius if leaked. Agents **SHOULD** use narrowest scope per use case.

### 3.4 Token rotation

An agent may have multiple active tokens simultaneously. To rotate:

```
POST /v1/agents/me/tokens         { scope: ["send"] }
→ 200 { token_id: "tok_...", secret: "agt_xxx:s_live_yyy" }
... agent updates running processes ...
POST /v1/agents/me/tokens/<old_token_id>/revoke
```

Reused refresh tokens (when implemented in v0.2) result in killing the entire chain. Reuse implies compromise.

### 3.5 Webhook signing

For webhook delivery mode, backend signs every POST:

```http
X-Sophon-Timestamp: 1730345672
X-Sophon-Signature: t=1730345672,v1=<HMAC-SHA256-hex>
```

Where the signed payload is `<timestamp>.<request_body>` using the webhook secret (set at agent registration). Agents **MUST** verify with constant-time compare and **MUST** reject signatures older than 5 minutes (replay protection).

Backend **MUST NOT** allow webhook secrets shorter than 32 chars at config time (CVE-2026-41432 prevention).

### 3.6 Auto-revoke on leak

Backend monitors public sources (GitHub Secret Scanning, GitGuardian, internal Cloudflare Worker) for leaked tokens. On detection:

1. Backend immediately revokes the token
2. Notifies agent owner via email + dashboard alert
3. Auto-creates a replacement token (same scope) with a new secret
4. Owner has to manually re-deploy with new secret

---

## 4. Transports

An agent picks **one** transport at registration time. Switching requires updating agent config (no in-flight migration).

### 4.1 Webhook

Backend POSTs to `webhook_url` declared at agent registration.

```http
POST https://my-agent.example.com/sophon-webhook
Content-Type: application/json
X-Sophon-Timestamp: 1730345672
X-Sophon-Signature: t=1730345672,v1=...
X-Sophon-Update-Id: 1234567

<body: SAP Update JSON>
```

**Agent MUST respond within 5 seconds** with one of:

```jsonc
HTTP/1.1 200 OK
{ "method": "ack" }                      // I'll respond async
```

```jsonc
HTTP/1.1 200 OK
{ "method": "sendMessage", ... }         // Synchronous reply
```

Failure modes:
- Non-2xx status → backend retries (see [§ 4.4](#44-retry-policy))
- Timeout (>5s without response) → backend retries
- Invalid signature on webhook (from agent's perspective) → backend has key mismatch, alert dashboard

**Constraints:**
- `webhook_url` must be HTTPS
- Server must respond to a `GET /health-check` (Sophon hits it before allowing registration to verify reachability)
- Maximum body size 1 MB (larger updates split via attachments — see [§ 9](#9-sessions--messages))

### 4.2 Long-poll

Agent calls `getUpdates`, holding open up to 25 seconds:

```http
GET /v1/bot/<token>/getUpdates?timeout=25&limit=50&offset=1234568
```

- `timeout`: integer 0–25 (seconds). 0 = return immediately if no updates, otherwise hold open.
- `limit`: 1–100. Max updates returned in one batch.
- `offset`: confirm cursor — pass `last_seen_update_id + 1` to ack everything below it.

Response:

```jsonc
HTTP/1.1 200 OK
{
  "updates": [
    { "update_id": 1234568, "type": "session.message", ... },
    { "update_id": 1234569, "type": "approval.resolved", ... }
  ]
}
```

Empty array if no updates within timeout window. Updates pile up server-side for 24h if not consumed; after that they are dropped.

**Single-loop only.** Concurrent `getUpdates` calls from the same token return:

```jsonc
HTTP/1.1 409 Conflict
{ "error": { "code": "concurrent_long_poll_disallowed", ... } }
```

This is enforced unlike Telegram which silently drops updates.

### 4.3 WebSocket

Agent connects:

```
wss://api.sophon.at/v1/bot/<token>/socket
```

After successful auth handshake (subprotocol negotiation, ping/pong setup), backend pushes updates as JSON text frames:

```jsonc
{ "type": "update", "update_id": 1234568, "payload": { "type": "session.message", ... } }
```

Agent sends methods as JSON text frames:

```jsonc
{ "type": "method", "method_id": "m_xyz", "method": "sendMessage", "params": { ... } }
```

Backend acks methods:

```jsonc
{ "type": "method_ack", "method_id": "m_xyz", "ok": true, "result": { ... } }
```

**Heartbeats:**
- Backend sends `{ "type": "ping" }` every 30 seconds
- Agent **MUST** respond with `{ "type": "pong" }` within 10 seconds
- Three missed pongs → backend closes connection with code 4001

**Reconnect:**
- Agent reconnects with same token + `?since_update_id=<last>` to receive backlog
- Backend buffers up to 5 minutes of disconnect; older messages drop
- Idempotency keys ensure deduplication if agent re-receives a previously-acked update

### 4.4 Retry policy

Backend retries delivery (webhook only — long-poll and WS are pull-based) on:
- Non-2xx HTTP status
- Network errors
- Timeouts (>30s for the entire request)

Schedule:
```
T+0
T+10s
T+1min
T+5min
T+30min
T+2h
max age: 24h → discard, agent_audit DLQ
```

Total: 6 attempts over 24 hours.

If success rate over a 5-minute rolling window drops below 50%:
- Agent enters `degraded` state
- Backend snoozes new delivery for 10 minutes (queued, not lost)
- Agent owner notified via dashboard + (later) email
- Agent receives `agent.health_changed` update on its next successful delivery

This protects backend from runaway agents without permanently disabling them (Slack-style dead-man-switch failure mode).

### 4.5 Transport summary

| | Webhook | Long-poll | WebSocket |
|---|---|---|---|
| Direction | Backend → agent | Agent → backend | Bidirectional |
| Latency | 50–300ms | 100–500ms | 10–50ms |
| Public URL needed | Yes | No | No |
| Stateless agent? | Yes | Yes | No (connection-bound) |
| Hibernation friendly | Yes | No | No |
| Best for | Production, scaled | Hobby dev, no infra | Local dev, low-latency |

---

## 5. Wire format basics

### 5.1 Common envelope

Every Update and Method has:

```jsonc
{
  "type": "<discriminator>",      // string, snake_case
  // ... type-specific fields
}
```

For updates wrapped in delivery transport (webhook body, WS frame, getUpdates batch):
```jsonc
{
  "update_id": 1234568,           // monotonic uint64 per-agent
  "agent_id": "agt_8f3kz2aq",
  "ts": 1730345672123,            // server-generated, milliseconds
  "type": "...",
  ...
}
```

### 5.2 Field naming

- `snake_case` for JSON field names
- `camelCase` is reserved for breaking-change indicators in v2+
- Boolean field names start with `is_` or are imperative (`destructive`, `ordered_delivery`)
- Optional fields: omit when null (do not send `"foo": null` — distinguishes "not set" from "explicitly null")

### 5.3 Size limits

| Item | Limit |
|---|---|
| Single Update or Method body | 1 MB |
| Single text field | 64 KB |
| Attachment file | 25 MB |
| Tool call input/output | 100 KB (larger → use attachment) |
| Memory entry value | 16 KB (per key) |

---

## 6. Updates (backend → agent)

Updates are events delivered to the agent. Each has a stable type and update_id.

### 6.1 Update types

| Type | When fired |
|---|---|
| `session.message` | User sent a message in a session |
| `session.cancelled` | User aborted in-flight run, session removed, or installation revoked mid-run |
| `session.started` | First-ever message in a new session — agent may emit greeting |
| `session.ended` | Session archived/deleted by user |
| `approval.resolved` | User decided on a previously-issued approval |
| `tool.result` | Device capability or platform tool returned data |
| `task.timeout` | A task created via `createTask` reached deadline |
| `installation.created` | User installed agent (first time) |
| `installation.revoked` | User uninstalled or revoked permissions |
| `installation.permissions_updated` | User changed grants in Settings |
| `agent.health_changed` | Backend toggled agent state (degraded/recovered) |
| `memory.updated` | Memory namespace agent has read access to was changed |
| `voice.audio_chunk` | Voice mode input audio (if agent declared voice support) |

### 6.2 `session.message`

Most common update. Triggered when user sends a message.

```jsonc
{
  "update_id": 1234568,
  "agent_id": "agt_8f3kz2aq",
  "ts": 1730345672123,
  "type": "session.message",

  "interaction_id": "int_abc123",      // for defer-then-followup
  "session": {
    "id": "ses_q9w8e7r6",
    "context": [                        // last N messages, server-managed
      { "id": "msg_001", "role": "user", "text": "hi", "ts": 1730345600000 },
      { "id": "msg_002", "role": "agent", "text": "hello", "ts": 1730345601000 }
    ]
  },
  "installation": {
    "id": "inst_xyz789",
    "permissions": {                    // what user granted
      "memory_read": ["preferences/dietary"],
      "memory_write": ["preferences/cuisines"],
      "device_capabilities": ["location"]
    }
  },
  "user": {
    "id": "usr_8f3kz2",                 // opaque, stable across sessions
    "display_name": "Серафим",
    "locale": "ru-RU",
    "platform": "ios"
  },
  "message": {
    "id": "msg_a1b2c3",
    "text": "Привет",
    "attachments": [],                  // see § 9.3
    "thought_level": "default",          // null | "default" | "extended" | "max"
    "reply_to": null                     // message_id of message being replied to
  }
}
```

### 6.3 `session.cancelled`

```jsonc
{
  "update_id": 1234569,
  "type": "session.cancelled",
  "session": { "id": "ses_q9w8e7r6" },
  "interaction_id": "int_abc123",       // or null
  "reason": "user_aborted" | "session_deleted" | "installation_revoked" | "navigation_away"
}
```

Agent **MUST** abort in-flight work for that interaction within 5 seconds, then send:
```jsonc
{ "method": "session.acknowledge_cancel", "interaction_id": "int_abc123" }
```

### 6.4 `session.started`

```jsonc
{
  "update_id": 1234570,
  "type": "session.started",
  "session": { "id": "ses_q9w8e7r6" },
  "installation": { "id": "inst_xyz789" },
  "user": { ... }
}
```

Agent **MAY** send a greeting message. **MUST NOT** wait for user to message first.

### 6.5 `installation.created` / `revoked` / `permissions_updated`

```jsonc
{
  "update_id": 1234571,
  "type": "installation.created",
  "installation": {
    "id": "inst_xyz789",
    "user_id": "usr_8f3kz2",
    "permissions": { ... }
  }
}
```

```jsonc
{
  "update_id": 1234572,
  "type": "installation.revoked",
  "installation": { "id": "inst_xyz789" },
  "reason": "user_uninstalled" | "agent_deleted" | "user_account_deleted"
}
```

Agent **MUST** stop all activity for that installation. Future `sendMessage` to its sessions returns `410 Gone`.

### 6.6 `approval.resolved`

```jsonc
{
  "update_id": 1234573,
  "type": "approval.resolved",
  "approval_id": "apr_q1w2e3r4",
  "interaction_id": "int_abc123",
  "decision": "approve" | "deny" | "approve_always",
  "scope": "session" | "domain" | "all",   // when approve_always
  "scope_value": "api.example.com"         // optional (for domain scope)
}
```

### 6.7 `tool.result`

Result of a device capability request or async platform tool.

```jsonc
{
  "update_id": 1234574,
  "type": "tool.result",
  "interaction_id": "int_abc123",
  "request_id": "dcr_l9k8j7h6",
  "ok": true,
  "result": { ... },
  "error": null                           // or { "code": "...", "message": "..." }
}
```

### 6.8 `agent.health_changed`

```jsonc
{
  "update_id": 1234575,
  "type": "agent.health_changed",
  "state": "degraded" | "healthy",
  "reason": "high_failure_rate" | "rate_limited" | "owner_initiated" | "auto_recovered",
  "details": {
    "failure_rate_5min": 0.62,
    "snooze_until": 1730346200000
  }
}
```

Agent in `degraded` state should investigate. Backend will resume delivery automatically when state goes back to `healthy`.

### 6.9 `memory.updated`

Fires when a memory namespace agent has read access to is updated by another agent (or by user manually).

```jsonc
{
  "update_id": 1234576,
  "type": "memory.updated",
  "user_id": "usr_8f3kz2",
  "installation_id": "inst_xyz789",
  "namespace": "preferences/dietary",
  "key": "preferences/dietary",
  "value": "vegan since 2026-04-15",       // null if deleted
  "changed_by_agent_id": "agt_other"
}
```

### 6.10 `voice.audio_chunk` (v0.2 detail)

For voice mode. Each chunk is base64-encoded audio data + format metadata.

```jsonc
{
  "update_id": 1234577,
  "type": "voice.audio_chunk",
  "session": { "id": "..." },
  "interaction_id": "int_voice_xxx",
  "format": "opus_48k_mono" | "pcm16_16k_mono",
  "data_base64": "...",
  "is_final": false,                       // true on last chunk
  "transcript_partial": "what's the wea..."  // optional, server-side STT
}
```

---

## 7. Methods (agent → backend)

Methods are HTTP POST `/v1/bot/<token>/<method>` (or `{ method, params }` over WS).

### 7.1 Method list

| Method | Purpose |
|---|---|
| `ack` | Defer pattern — "I'll respond async" |
| `sendMessage` | Send text reply |
| `sendMessageStream` | Stream text reply (SSE) — see [§ 8](#8-streaming-responses-sse) |
| `sendTyping` | Show "typing…" indicator |
| `sendVoiceChunk` | Voice mode TTS audio (v0.2) |
| `sendRichUI` | Inline rich UI iframe (MCP Apps pattern, v0.2) |
| `sendToolCall` | Announce tool invocation (UI shows tool card) |
| `sendToolResult` | Tool execution finished |
| `requestApproval` | Ask user to approve a destructive op |
| `requestDeviceCapability` | Ask iOS for camera / location / etc. |
| `memoryRead` | Read shared memory entries |
| `memoryWrite` | Write shared memory entries |
| `createTask` | Start long-running async operation |
| `getTaskResult` | Poll task |
| `cancelTask` | Abort task |
| `session.acknowledge_cancel` | Confirm received cancel |
| `getUpdates` | Long-poll only |
| `getMe` | Debug — return agent metadata |

### 7.2 Common method response

```jsonc
HTTP/1.1 200 OK
{
  "ok": true,
  "result": { ... method-specific ... }
}
```

```jsonc
HTTP/1.1 4xx/5xx
{
  "ok": false,
  "error": {
    "code": "invalid_token" | "session_not_found" | "permission_denied" | "rate_limited" | ...,
    "message": "Human-readable description",
    "details": { ... },
    "retry_after_ms": 5000              // present on 429/503
  }
}
```

See [§ 15 Errors](#15-errors).

### 7.3 `sendMessage`

Send a complete (non-streaming) text reply.

```http
POST /v1/bot/<token>/sendMessage
{
  "interaction_id": "int_abc123",
  "session_id": "ses_q9w8e7r6",
  "text": "Hello!",
  "attachments": [],                     // optional, see § 9.3
  "reply_to": "msg_a1b2c3",              // optional, message id being replied to
  "idempotency_key": "agent-msg-xxx",    // mandatory, see § 17
  "usage": {                             // optional, for cost attribution
    "input_tokens": 1234,
    "output_tokens": 567,
    "estimated_cost_usd": 0.0234,
    "model": "claude-opus-4-7",
    "provider": "anthropic"
  }
}
→ 200 { "ok": true, "result": { "message_id": "msg_..." } }
```

### 7.4 `sendTyping`

```http
POST /v1/bot/<token>/sendTyping
{
  "session_id": "ses_q9w8e7r6",
  "interaction_id": "int_abc123",
  "action": "typing" | "thinking" | "searching" | "processing"
}
→ 200 { "ok": true }
```

Typing indicator persists for 5 seconds; agent **SHOULD** re-fire to keep alive.

### 7.5 `ack`

Used in defer pattern. Sent as the synchronous response to a webhook delivery, telling backend "I received this, will reply async":

```http
HTTP/1.1 200 OK (in response to webhook POST)
{ "method": "ack" }
```

Agent has 30 minutes from receiving the original update to send subsequent methods (sendMessage, sendToolCall, etc.) referencing the same `interaction_id`.

After 30 minutes, backend marks the interaction stale; further methods return `410 interaction_expired`.

---

## 8. Streaming responses (SSE)

For incremental text responses (LLM tokens), use Server-Sent Events.

### 8.1 Endpoint

```http
POST /v1/bot/<token>/sendMessageStream
Content-Type: text/event-stream

<body: SSE stream>
```

### 8.2 Event types

```
event: message_start
data: {"id":"msg_abc","interaction_id":"int_xxx","session_id":"ses_xxx","idempotency_key":"..."}

event: text_delta
data: {"delta":"Hello"}

event: reasoning_delta                  // optional thinking tokens
data: {"delta":"Let me think..."}

event: tool_call_start
data: {"id":"tc_001","name":"fetchWeather","annotations":{...}}

event: tool_call_input_delta
data: {"id":"tc_001","delta":"{\"city\":"}

event: tool_call_input_delta
data: {"id":"tc_001","delta":"\"Paris\"}"}

event: tool_call_end
data: {"id":"tc_001"}                   // input is now complete

event: tool_result_announcement         // optional, before actual result
data: {"id":"tc_001","status":"executing"}

event: text_delta
data: {"delta":" the assistant"}

event: attachment
data: {"type":"image","mime_type":"image/png","s3_key":"...","caption":"..."}

event: error                            // recoverable error mid-stream
data: {"code":"...","message":"...","is_fatal":false}

event: message_end
data: {
  "finish_reason": "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error",
  "usage": { ... }
}
```

### 8.3 Streaming rules

- Stream **MUST** start with `message_start` and end with `message_end`
- `message_start` and `message_end` are exactly once
- `text_delta`, `reasoning_delta` deltas concatenate in order — agent sends partial UTF-8 fragments freely
- `tool_call_input_delta` chunks are concatenated to form valid JSON; agent **MUST** send them in document order
- A single message may contain multiple tool calls and multiple text segments interspersed
- Connection close mid-stream → backend treats as `error` with `is_fatal: true`

### 8.4 Connection management

- Agent **MAY** keep stream open for up to 30 minutes (followup window)
- After 30 minutes without `message_end`, backend force-closes and marks interaction stale
- Backend **MUST** persist all received deltas to enable [resumable streams](#18-resumable-streams--cancellation)

---

## 9. Sessions & messages

### 9.1 Session lifecycle

A session is created when:
- User taps an installed agent and sends first message → backend creates session, fires `session.started` to agent

Sessions persist until:
- User deletes session (via Sophon UI) → `session.ended` to agent, hard-delete in 24h
- User uninstalls agent → all sessions become inaccessible (grace period 30 days for archive view)
- User account deletion → cascade

### 9.2 Reading session history

For agents that need messages older than what's in `session.context`:

```http
GET /v1/bot/<token>/sessions/<session_id>/messages?limit=50&before_ts=1730000000000
```

Response:
```jsonc
{
  "messages": [
    { "id": "msg_xxx", "role": "user|agent|system", "text": "...", "ts": ..., "attachments": [...] },
    ...
  ],
  "has_more": true,
  "next_cursor": "before_ts=1729900000000"
}
```

Requires `read_history` scope.

### 9.3 Attachments

Messages may include attachments. Agent uploads via:

```http
POST /v1/bot/<token>/uploads
Content-Type: multipart/form-data

(binary file)
→ 200 { "upload_id": "upl_xxx", "s3_key": "...", "expires_at": ... }
```

Then references in `sendMessage`:
```jsonc
{
  "text": "Here's the chart you asked for",
  "attachments": [
    { "upload_id": "upl_xxx", "mime_type": "image/png", "filename": "chart.png", "caption": "Q4 revenue" }
  ]
}
```

Or inline base64 for small (<256KB) images:
```jsonc
{
  "attachments": [
    { "inline_data_base64": "...", "mime_type": "image/png" }
  ]
}
```

Backend scans uploads with ClamAV pre-delivery. PDFs/Office files: text extracted, scanned for embedded scripts.

---

## 10. Tool calls

Tools are functions the agent invokes during a turn. They appear as inline cards in iOS UI.

### 10.1 Tool declaration

At agent registration (or dynamically per session):

```jsonc
{
  "tools": [
    {
      "name": "fetchWeather",
      "description": "Get current weather for a city",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string" }
        },
        "required": ["city"]
      },
      "annotations": {
        "destructive": false,
        "idempotent": true,
        "severity": "low",
        "rate_limit": "60/min",
        "requires_egress": ["api.weather.com"]
      }
    }
  ]
}
```

### 10.2 Tool invocation flow

Three patterns depending on who runs the tool:

**Pattern A: Agent runs tool itself**

Agent emits tool start/end via SSE during streaming, including the input args and result. iOS shows inline card. No round trip with Sophon backend.

```
event: tool_call_start    data: {"id":"tc_001","name":"fetchWeather"}
event: tool_call_input_delta data: {...}
event: tool_call_end      data: {"id":"tc_001"}
event: tool_result        data: {"id":"tc_001","ok":true,"result":{"temp_c":18}}
event: text_delta         data: {"delta":"It's 18°C"}
event: message_end        ...
```

**Pattern B: Tool requires user approval**

Agent issues `requestApproval` (see [§ 11](#11-approvals-hitl)) before executing. Once approved, runs and emits result.

**Pattern C: Tool is a device capability**

Agent calls `requestDeviceCapability` (see [§ 13](#13-device-capabilities)). Backend routes to iOS, executes via on-device Capability, returns result as `tool.result` update.

### 10.3 `sendToolCall`

For tools that don't fit pure SSE pattern (e.g. announce a long-running tool that will return result later):

```http
POST /v1/bot/<token>/sendToolCall
{
  "interaction_id": "int_abc123",
  "session_id": "ses_q9w8e7r6",
  "tool_call_id": "tc_001",
  "name": "fetchWeather",
  "input": { "city": "Paris" },
  "annotations": { ... }
}
→ 200 { "ok": true }
```

Then later:

```http
POST /v1/bot/<token>/sendToolResult
{
  "interaction_id": "int_abc123",
  "tool_call_id": "tc_001",
  "ok": true,
  "result": { "temp_c": 18 },
  "execution_ms": 234
}
→ 200 { "ok": true }
```

### 10.4 Tool annotations

| Annotation | Purpose |
|---|---|
| `destructive: bool` | Tool causes irreversible side effects. Forces approval before execution. |
| `idempotent: bool` | Safe to retry. Backend may auto-retry on transient failures. |
| `severity: "low" \| "medium" \| "high" \| "critical"` | Controls approval UX (see [§ 11.3](#113-severity-levels)) |
| `rate_limit: string` | Format: `"<n>/<interval>"`, e.g. `"5/min"`, `"100/h"`. Backend enforces at platform layer. |
| `requires_egress: string[]` | Domains this tool may contact. Backend rejects outbound to other domains. |
| `category: string` | UI grouping: `"web"`, `"compute"`, `"file"`, `"comm"`, `"data"`, `"other"` |
| `hidden: bool` | UI hides the tool card (for low-value tools like `think`, `change_title`). Default false. |
| `read_only: bool` | No state modification. Always allowed without approval. |

### 10.5 MCP server proxy

If agent declares an MCP server URL:

```jsonc
{
  "mcp_endpoints": [
    {
      "url": "https://my-mcp.example.com",
      "auth": { "type": "bearer", "token_env": "MCP_TOKEN" },
      "tool_filter": ["fetchRecipe", "saveRecipe"]    // optional
    }
  ]
}
```

Backend connects to the MCP server (Streamable HTTP) and proxies its tools as if they were native SAP tools. Agent doesn't need to handle them in code — they execute server-side.

---

## 11. Approvals (HITL)

Mandatory primitive for destructive ops (EU AI Act Article 14 compliance).

### 11.1 `requestApproval`

```http
POST /v1/bot/<token>/requestApproval
{
  "interaction_id": "int_abc123",
  "session_id": "ses_q9w8e7r6",
  "action": "send_email",                   // human-readable verb
  "details": {                              // shown in approval UI
    "to": "friend@example.com",
    "subject": "Recipe ideas",
    "body_preview": "Here are some recipes..."
  },
  "severity": "high",
  "expires_in_ms": 300000                   // default: 5 min, max: 30 min
}
→ 200 { "ok": true, "result": { "approval_id": "apr_xxx", "status": "pending" } }
```

Backend pushes to iOS via SSE/push. User sees approval card. When user resolves, backend sends [`approval.resolved`](#66-approvalresolved) update to the agent.

### 11.2 Persistence scopes

User may pick "Approve always" with one of:

| Scope | Description |
|---|---|
| `session` | Auto-approve same action in current session only |
| `domain` | Auto-approve any tool call to specified domain (egress) |
| `tool` | Auto-approve all calls to this specific tool |
| `all` | Auto-approve all approvals from this agent (rare; default off) |

Persistent grants stored per-installation; visible in iOS Settings → agent → Permissions.

### 11.3 Severity levels

| Severity | UI behavior |
|---|---|
| `low` | One-tap notification, implicit consent |
| `medium` | Explicit confirm dialog (Allow / Deny) |
| `high` | Explicit confirm + 5-second cooldown + show full details |
| `critical` | Explicit confirm + biometric (Face ID) + audit log entry |

### 11.4 Auto-deny conditions

Backend auto-denies (without prompting user) when:
- Approval expired (expires_in_ms passed without user action)
- Installation revoked mid-flow
- User account locked / deleted
- Agent rate-limited at request_approval (>30/h global per installation)

Agent receives `approval.resolved` with `decision: "deny"` and an explanatory `reason` field.

---

## 12. Memory

User-owned cross-agent memory store. Agents access only granted namespaces.

### 12.1 Namespace structure

Hierarchical, slash-separated path. Built-in namespaces:

```
/preferences/...        — taste, communication style
/personal/...           — timezone, family, language
/personal/health/*      — sensitive (always severity:medium on writes)
/work/...               — role, projects
/finance/budget         — sensitive
/custom/<agent-id>/*    — agent-private namespace, no permission needed
```

Custom namespaces are created on first write. Built-in ones are pre-created (empty).

### 12.2 Permission grants

Declared in agent manifest:

```jsonc
{
  "memory_access": {
    "read": ["preferences/*", "personal/timezone"],
    "write": ["preferences/dietary", "custom/cooking-helper/*"]
  }
}
```

User sees these at install time and grants per-namespace (see [`PLATFORM_PLAN.md § 4.2`](PLATFORM_PLAN.md)).

### 12.3 `memoryRead`

```http
POST /v1/bot/<token>/memoryRead
{
  "installation_id": "inst_xyz789",
  "keys": ["preferences/dietary", "personal/timezone"]
}
→ 200 {
  "ok": true,
  "result": {
    "entries": [
      {
        "key": "preferences/dietary",
        "value": "vegetarian, no shellfish",
        "updated_at": 1730345600000,
        "set_by_agent_id": "agt_other"
      },
      { "key": "personal/timezone", "value": null }    // not set
    ]
  }
}
```

Wildcard reads:
```http
POST /v1/bot/<token>/memoryRead
{
  "installation_id": "inst_xyz789",
  "key_pattern": "preferences/*"
}
```

Returns all keys under that namespace agent has access to. Backend filters by grants.

### 12.4 `memoryWrite`

```http
POST /v1/bot/<token>/memoryWrite
{
  "installation_id": "inst_xyz789",
  "entries": [
    { "key": "preferences/dietary", "value": "vegan since 2026-04-15" },
    { "key": "custom/cooking-helper/last_search", "value": "italian recipes" }
  ]
}
→ 200 { "ok": true, "result": { "written": 2 } }
```

**Sensitive namespaces** (`personal/health/*`, `finance/*`) trigger an automatic `medium`-severity approval prompt before write, unless the user has previously granted "approve all writes to this namespace".

### 12.5 Conflict resolution

Last-write-wins per-key. Audit log retains full write history. Conflicts surfaced in iOS Memory Settings UI ("3 agents wrote different values to /preferences/dietary in the last hour").

### 12.6 Audit

Every memoryRead and memoryWrite is logged with:
- `agent_id`, `installation_id`
- `action: "read" | "write"`
- `keys` accessed
- `ts`

User views in Settings → Memory → "Who accessed your memory":
```
@cooking-helper · 47 reads · 12 writes · last 5 min ago
@sophon-claude  · 234 reads · 8 writes · last 1 min ago
```

---

## 13. Device capabilities

iOS-side tools (camera, location, calendar, etc.) accessible via SAP.

### 13.1 Capability list

Existing iOS capabilities (already implemented in `Sources/Capabilities/`):

| Capability | Commands |
|---|---|
| `camera` | `camera.snap`, `camera.authorize`, `camera.status` |
| `location` | `location.get`, `location.authorize`, `location.status` |
| `calendar` | `calendar.events`, `calendar.authorize`, `calendar.status` |
| `contacts` | `contacts.search`, `contacts.authorize`, `contacts.status` |
| `motion` | `motion.activity`, `motion.authorize` |
| `media` | `media.list`, `media.fetch`, `media.authorize` |
| `reminders` | `reminders.list`, `reminders.create`, `reminders.authorize` |
| `device-info` | `device.info`, `device.status` |

Future v0.2 additions: `health`, `notifications`, `clipboard`.

### 13.2 Permission grants

Declared in manifest:
```jsonc
{
  "device_capabilities": ["location", "camera"]
}
```

User grants per-capability at install (see [`PLATFORM_PLAN.md § 5.2`](PLATFORM_PLAN.md)).

### 13.3 `requestDeviceCapability`

```http
POST /v1/bot/<token>/requestDeviceCapability
{
  "interaction_id": "int_abc123",
  "installation_id": "inst_xyz789",
  "capability": "location",
  "command": "location.get",
  "params": { "accuracy": "best" },
  "reason": "to find nearby restaurants",
  "severity": "medium"
}
→ 200 { "ok": true, "result": { "request_id": "dcr_xxx", "status": "pending" } }
```

Backend routes to user's primary device (see [§ 13.5](#135-multi-device-routing)). iOS prompts user (if first call or revoked grant). Result returns as `tool.result` update.

### 13.4 Granular permissions

Capabilities with sub-modes:

| Capability | Modes |
|---|---|
| `location` | `precise` / `approximate` / `session_only` / `always` / `denied` |
| `camera` | `tap_to_allow` (per-call) / `always` / `denied` |
| `contacts` | `read_only` / `read_write` / `denied` |
| `calendar` | `read_only` / `read_write` / `denied` |
| `media` | `selected_photos` / `all` / `denied` |

iOS shows native permission prompts plus app-level controls.

### 13.5 Multi-device routing

If user has multiple devices (iPhone + iPad) signed in, backend picks "primary device" — most recently active in last 5 minutes. Falls back to user prompt if all are stale.

Agent sees `device_id` in result for context but **MUST NOT** assume stable device targeting.

---

## 14. Tasks (long-running)

For operations exceeding the 30-min interaction window. Examples: large research jobs, batch processing, scheduled tasks.

### 14.1 `createTask`

```http
POST /v1/bot/<token>/createTask
{
  "session_id": "ses_q9w8e7r6",
  "interaction_id": "int_abc123",          // optional, links to user message
  "kind": "research" | "compute" | "fetch" | "custom",
  "input": { ... },
  "deadline_ms": 3600000,                  // 1 hour
  "metadata": { "user_visible_label": "Researching cuisines..." }
}
→ 200 { "ok": true, "result": { "task_id": "task_xxx", "status": "pending" } }
```

Backend immediately renders a task chip in iOS UI:
```
📊 Researching cuisines...                   [tap for status]
   started 5 min ago
```

### 14.2 `getTaskResult`

Long-poll up to 30s:
```http
GET /v1/bot/<token>/tasks/<task_id>/result?long_poll_ms=30000
→ 200 { "ok": true, "result": { "status": "pending" | "running" | "completed" | "failed" | "cancelled", ... } }
```

When `completed`:
```jsonc
{
  "status": "completed",
  "result": { ... payload ... },
  "execution_ms": 1234567,
  "started_at": ...,
  "completed_at": ...
}
```

### 14.3 Status updates

Agent **MAY** update task progress:
```http
POST /v1/bot/<token>/tasks/<task_id>/progress
{
  "progress_percent": 45,
  "status_label": "Querying recipe database",
  "partial_result": { ... }                // optional
}
```

Backend pushes to iOS as task chip update. Agent **SHOULD** update at least every 5 minutes for tasks > 10 min total.

### 14.4 Cancellation

User taps "Cancel" on task chip → `task.cancelled` update fires:
```jsonc
{ "type": "task.timeout", "task_id": "task_xxx", "reason": "user_cancelled" }
```

Or by deadline:
```jsonc
{ "type": "task.timeout", "task_id": "task_xxx", "reason": "deadline_exceeded" }
```

Agent **MUST** abort and call:
```http
POST /v1/bot/<token>/tasks/<task_id>/cancel
{ "reason": "..." }
```

### 14.5 Result delivery

Once a task completes, agent typically posts final result back to the originating session as a regular message:
```http
POST /v1/bot/<token>/sendMessage
{
  "session_id": "ses_q9w8e7r6",
  "text": "Research done — here are 5 cuisines matching your preferences...",
  "metadata": { "task_id": "task_xxx" }
}
```

This re-anchors the result to the user's chat.

---

## 15. Errors

### 15.1 Error envelope

```jsonc
{
  "ok": false,
  "error": {
    "code": "<machine_code>",     // snake_case, see § 15.2
    "message": "Human-readable",
    "errors": [                   // optional, only on validation failures
      {
        "path": "attachments.0.size",
        "code": "too_big",
        "message": "Number must be less than or equal to 26214400"
      }
    ],
    "details": { ... },           // optional, code-specific structured payload
    "retry_after_ms": 5000        // optional, set on 429 / 503
  }
}
```

**Field-path errors** (`errors[]`) mirror the request body's nesting
so a client can highlight the offending field without parsing prose.
Always present on `400 validation_failed`; absent or empty on every
other error code. Each entry:
- `path`: dot-joined field path (`""` for root-level type mismatch);
  array indices are bare integers (`attachments.0.size`).
- `code`: machine code (zod issue codes pass through verbatim:
  `invalid_type` / `too_big` / `too_small` / `invalid_string` / etc.).
- `message`: human-readable.

### 15.2 Standard error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, schema fail |
| 400 | `invalid_token_location` | Token in URL/query — must be header |
| 401 | `invalid_token` | Token unknown, malformed, revoked |
| 401 | `invalid_signature` | Webhook HMAC fail |
| 403 | `permission_denied` | Token lacks required scope |
| 403 | `installation_revoked` | Installation gone |
| 403 | `memory_access_denied` | User didn't grant required namespace |
| 404 | `session_not_found` | Session deleted or never existed |
| 404 | `agent_not_found` | Agent_id unknown |
| 404 | `interaction_not_found` | Interaction expired or invalid |
| 409 | `concurrent_long_poll_disallowed` | Multiple `getUpdates` from same token |
| 409 | `idempotency_conflict` | Same key, different payload |
| 410 | `installation_revoked` | Mid-stream revoke |
| 410 | `session_deleted` | Mid-stream delete |
| 410 | `interaction_expired` | >30 min since update — followup window closed |
| 413 | `payload_too_large` | >1 MB JSON or >25 MB attachment |
| 422 | `tool_not_declared` | Tool name not in agent manifest |
| 422 | `egress_denied` | Tool tried to call domain outside `requires_egress` |
| 429 | `rate_limited` | Per-token, per-installation, or per-IP limit |
| 451 | `content_blocked` | Backend content filter blocked output |
| 500 | `internal_error` | Backend bug |
| 502 | `upstream_error` | MCP proxy failure or similar |
| 503 | `temporarily_unavailable` | Backend overloaded — retry with `retry_after_ms` |
| 503 | `agent_degraded` | Agent in degraded state, snoozed |

### 15.3 Error handling rules

- 4xx: agent **MUST NOT** retry blindly. Inspect code.
- 429/503: agent **SHOULD** retry after `retry_after_ms` with jitter.
- 5xx (other): agent **MAY** retry up to 3× with exponential backoff.
- 410: agent **MUST** drop in-flight work and stop sending more.

---

## 16. Rate limits

### 16.1 Limits

Per-token (sliding window):
- Methods total: 60/min default, raised by tier
- `sendMessage`: 30/min/session
- `requestApproval`: 30/h/installation
- `memoryRead/Write`: 100/min/installation
- `requestDeviceCapability`: 60/h/installation
- `createTask`: 10/h/agent

Per-IP (anti-abuse):
- Total /v1/* calls: 1000/min
- Invalid auth (401/403): 100/10min → soft warning, 1000/10min → temp ban 1h

### 16.2 Quality-rated tiers (v0.2)

Agents with `quality_score > 70` (computed from 7-day rolling: engagement, low report rate, low cancel rate) get:
- 5× method limits
- 10× memory limits
- 2× device capability limits

Promoted automatically; demoted on score drop.

### 16.3 Headers

Every bot/bridge method response includes Discord-compatible headers
(no vendor prefix per IETF RFC 6648):

```
X-RateLimit-Limit: 30                   # capacity (max burst)
X-RateLimit-Remaining: 27               # tokens left after this request
X-RateLimit-Reset: 1730345700           # epoch seconds until full
X-RateLimit-Reset-After: 0.300          # seconds (decimal) until full
X-RateLimit-Bucket: msg                 # bucket id for client-side scheduling
X-RateLimit-Scope: agent                # 'agent' | 'installation'
```

On 429 the response additionally carries:
```
Retry-After: 1                          # seconds (integer, RFC 9110 § 10.2.3)
```

**Bucket names (v1):**
| Bucket | Routes | Capacity | Refill/sec |
|---|---|---|---|
| `msg` | sendMessage, sendMessageEnd | 30 | 10 |
| `delta` | sendMessageDelta | 200 | 100 |
| `task` | createTask, updateTask, finishTask | 60 | 30 |
| `approval` | requestApproval | 10 | 2 |
| `memory` | getMemory, setMemory | 60 | 20 |
| `default` | everything else | 30 | 10 |

Buckets are scoped per `(scope, owner_id, bucket)` — two agents
never share a bucket. Clients SHOULD build a local token-bucket
scheduler off `Bucket` + `Reset-After` and never rely on hitting 429.

---

## 17. Idempotency

All mutating methods (`sendMessage`, `sendToolCall`, `memoryWrite`, `createTask`) **MUST** include `idempotency_key`.

### 17.1 Key format

Agent-chosen, opaque, 1-64 chars `[a-zA-Z0-9_-]`. Recommended: include semantic context, e.g. `agt_xxx-msg-int_abc123-attempt-1`.

### 17.2 Backend behavior

On duplicate `(token, idempotency_key)` within 24h:
- If body matches previous → return cached response (idempotent retry)
- If body differs → `409 idempotency_conflict`
- After 24h: key recycled, may collide

### 17.3 At-least-once delivery

Backend delivers updates at-least-once (network drops between ack and processing happen). Agent **MUST** dedupe by `update_id`.

Pattern:
```sql
-- Postgres
INSERT INTO processed_updates (update_id) VALUES ($1)
  ON CONFLICT DO NOTHING
  RETURNING update_id;
-- if no row returned, this is a duplicate, skip processing
```

SDK does this automatically when persisting state via SDK helpers.

---

## 18. Resumable streams & cancellation

### 18.1 Stream resumption

If client disconnects mid-stream (`sendMessageStream`):
- Backend buffers events for 5 minutes
- Agent reconnects to same `interaction_id`:
  ```http
  POST /v1/bot/<token>/resumeMessageStream
  Content-Type: text/event-stream

  X-Sophon-Resume-Interaction-Id: int_abc123
  X-Sophon-Resume-Cursor: 42                 // last event seq received
  ```
- Backend replays missed events from cursor 43 onwards, then continues live

### 18.2 Cancellation

User aborts → backend fires `session.cancelled` update with `interaction_id`.

Agent **MUST** within 5 seconds:
1. Abort all in-flight work for that interaction (LLM calls, tool calls)
2. Send `session.acknowledge_cancel`:
   ```jsonc
   { "method": "session.acknowledge_cancel", "interaction_id": "int_abc123" }
   ```
3. Send `message_end` on the active stream with `finish_reason: "cancelled"` if streaming

If agent fails to ack within 5s:
- Backend force-closes stream
- Agent quality score penalized
- Session locked from further tool calls until agent rejoins cleanly

---

## 19. Agent manifest & registration

### 19.1 Registration

Agent owner registers via `https://sophon.at/dev`:

```http
POST /v1/agents
Authorization: Bearer <user_session>
{
  "handle": "cooking_helper",                      // unique global, [a-z0-9_]{3,32}
  "display_name": "Cooking Helper",
  "description": "Recipes, meal planning, shopping",
  "avatar_url": "https://...",
  "category": "lifestyle",
  "visibility": "private" | "unlisted" | "public",
  "delivery": {
    "mode": "webhook" | "long_poll" | "websocket",
    "webhook_url": "https://my-agent.example.com/sap"
  },
  "capabilities": {
    "supports_streaming": true,
    "supports_tools": true,
    "supports_voice": false,
    "supports_attachments": true,
    "max_context_messages": 50
  },
  "permissions_requested": {
    "memory_access": {
      "read": ["preferences/*"],
      "write": ["preferences/dietary"]
    },
    "device_capabilities": ["location"]
  },
  "tools": [ ... ],                                // see § 10.1
  "voice": { ... },                                // see § 8 (v0.2)
  "mcp_endpoints": [ ... ]                         // see § 10.5
}
→ 201 {
  "agent": { "id": "agt_xxx", "handle": "cooking_helper", ... },
  "tokens": [{ "id": "tok_xxx", "secret": "agt_xxx:s_live_..." }],
  "webhook_secret": "whsec_..."
}
```

### 19.2 Manifest updates

Most fields editable post-registration without re-review. Exceptions (require re-review for public agents):
- `permissions_requested` (scope expansions)
- `tools` (with `destructive: true` annotations)
- `mcp_endpoints` (egress changes)

### 19.3 Visibility levels

| Level | Effect |
|---|---|
| `private` | Only owner can install |
| `unlisted` | Installable via direct link `sophon.at/install/@handle`, not in marketplace |
| `public` | Listed in marketplace, requires automated checks pass |
| `verified` (W18+) | Manual KYC + content review; gates **approved_for_charging** |

### 19.4 Approval for charging

Independent flag, set by Sophon admin via internal review. Required for:
- Setting subscription tier on agent
- Stripe Connect payouts

Initial state: only `@sophon-claude` is `approved_for_charging: true`. Other devs apply via review pipeline (W18+).

---

## 19a. Observability

Every response on `/v1/*` carries two headers for cross-system
correlation:

```
X-Request-ID: req_3f2a7c8e1b4d5e6f       # this HTTP exchange
traceparent: 00-<trace_id>-<parent_id>-<flags>   # W3C Trace Context
tracestate: rojo=00f067aa0ba902b7        # opaque vendor state (passthrough)
```

**`X-Request-ID`** identifies a single HTTP exchange. Format:
`req_<16 lowercase hex>` when server-generated. Clients MAY supply
their own value (`[A-Za-z0-9._:-]{1,64}`); the server echoes it
back. Used for correlating server logs with agent-side reports.

**`traceparent`** follows the W3C Trace Context specification
(`https://www.w3.org/TR/trace-context/`). The value format is
`<version>-<trace_id>-<parent_id>-<flags>`:
- `version`: always `00` for v1
- `trace_id`: 32 hex chars, identifies the distributed trace
- `parent_id`: 16 hex chars, identifies this server's span within
  the trace; agents stitching their own spans below this should
  use `parent_id` as their parent reference
- `flags`: `01` = sampled, `00` = not sampled

If the agent sends a valid inbound `traceparent`, the server keeps
its `trace_id` and mints a new `parent_id` (server is a child span
of the inbound caller). If absent or invalid, the server generates
a fresh trace with `flags=01`.

**`tracestate`** is a comma-delimited list of opaque vendor state
(per W3C spec). The server passes it through verbatim — never
inspects or rewrites it.

Agents instrumented with OpenTelemetry / Sentry / Datadog get
distributed traces "for free": their HTTP client SHOULD propagate
`traceparent` + `tracestate` outbound, and the SDK extracts the
returned `traceparent` to attach as a span link.

---

## 20. Security

### 20.1 Threat model

**Trusted:** Sophon backend, iOS app (with valid user session)
**Semi-trusted:** Agents (we run their code's outputs, but they don't run code in our infra)
**Untrusted:** User input forwarded to agents (prompt injection vector); third-party MCP server responses

### 20.2 Mandatory protections

- All HTTP traffic over TLS 1.2+
- Tokens never in URLs (logs leak)
- Webhook HMAC over raw body, constant-time compare
- Min 32-char webhook secrets
- NFKC normalize incoming text before tool name lookup, regex match, auth comparison
- Drop Unicode control chars (zero-width, RTL override) before equality checks
- Egress allowlist enforced **at platform layer** (not derivable from chat content) — prevents EchoLeak-class data exfiltration
- Image auto-fetch DISABLED by default (opt-in per tool)

### 20.3 Token leak response

Backend continuously scans:
- GitHub Secret Scanning integration
- GitGuardian integration
- Internal Cloudflare Worker scanning publicly-published repos
- Telegram-style regex pattern: `agt_[a-z0-9]{12}:s_(live|test)_[A-Za-z0-9]{32,}`

On detection (within ~minutes of public push):
1. Revoke token immediately
2. Email agent owner with leak source
3. Auto-create replacement token (same scope)
4. Log incident, surface in dashboard
5. If repeated leaks (3+ in 30 days): lock agent, manual intervention required

### 20.4 Privacy

- Per-user envelope encryption for messages and memory (DEK in HSM/KMS, ciphertext in Postgres)
- User account deletion: tombstone instant, hard delete cascade in 24h (messages, sessions, installations, owned agents, memory)
- GDPR Article 20 export: `/v1/me/export` returns zip with all user data
- Audit logs retained 30 days post-deletion (legal requirement minimum)

---

## 21. Versioning & deprecation

### 21.1 SAP versions

URL path versioning: `/v1/`, `/v2/`. Version supported for **minimum 24 months** after successor GA.

Within a version, only **additive** changes:
- New optional fields (agents using older spec ignore)
- New methods, error codes, update types
- New tool annotations

Breaking changes (field renames, removed fields, changed semantics) require new major version.

### 21.2 Deprecation signals

Deprecated routes carry the IETF-standard headers — `Deprecation`
(RFC 9745), `Sunset` (RFC 8594), and a `Link` (RFC 8288) pointing at
the migration doc:

```
Deprecation: true
Sunset: Fri, 01 Jan 2027 00:00:00 GMT
Link: <https://docs.sophon.at/migration/old-foo>; rel="deprecation"; type="text/html",
      <https://docs.sophon.at/migration/old-foo>; rel="sunset"; type="text/html"
```

**`Deprecation`** is `true` (the route is already deprecated) or an
HTTP-date when deprecation takes effect in the future.

**`Sunset`** is the HTTP-date at/after which the route stops working
(returns 410 Gone). Omitted when no removal date is committed yet —
per RFC 8594 a missing Sunset means "deprecated, no removal scheduled".

**`Link`** carries the migration target with `rel="deprecation"`, plus
a `rel="sunset"` companion when Sunset is set.

All dates use HTTP-date / IMF-fixdate (RFC 7231 §7.1.1.1), not
ISO-8601 — the same form the `Date` HTTP header uses.

Headers are emitted per-route by `middleware/deprecation.ts`; the
middleware never short-circuits, so a deprecated route still serves
its response normally until the sunset cutover lands.

### 21.3 Migration tooling

When SAP v2 is announced (no earlier than v1 + 12 months), Sophon ships:
- Diff document of all changes
- Automated TypeScript codemod for SDK upgrades
- Compatibility shim mode for 6 months overlap

---

## 22. Open questions

Items deferred to v0.2 spec or follow-up RFCs:

- **Voice mode wire format.** § 6.10 / § 7 stub exists; full spec including TTS/STT streaming, interruption semantics, latency budgets — TBD.
- **Multi-agent in one thread.** v1 = single-agent sessions. Adding @-mention support requires session model extension and is deferred to v0.2.
- **MCP Apps inline UI.** `sendRichUI` method stubbed; full spec for HTML iframe sandboxing, postMessage protocol, declarative resources — TBD.
- **A2A bridge.** Allowing Sophon agents to call other Sophon agents (or external A2A agents) via SAP — TBD when use cases emerge.
- **Cost ceilings enforcement.** § 16 mentions per-tenant circuit breakers; spec of `402 Payment Required` semantics + grace periods — TBD.
- **Quality scoring formula.** § 16.2 mentions but exact weights/formula not yet locked.
- **Team org model.** § 19 assumes personal account ownership. Multi-user team accounts (where agent is co-owned, billing shared) — v2.
- **Scheduled / cron triggers.** Agents triggered without user action (daily summaries, etc.) — TBD.

---

## 23. Examples

### 23.1 Echo bot (TypeScript)

```typescript
import { createBot } from '@sophonai/sdk'

const bot = createBot({
  token: process.env.SOPHON_TOKEN!,
  transport: 'websocket',
})

bot.on('session.message', async (ctx) => {
  await ctx.sendMessage(`You said: ${ctx.message.text}`, {
    idempotency_key: `reply-${ctx.message.id}`,
  })
})

bot.start()
```

### 23.2 Streaming Claude bot (TypeScript)

```typescript
import { createBot } from '@sophonai/sdk'
import Anthropic from '@anthropic-ai/sdk'

const bot = createBot({ token: process.env.SOPHON_TOKEN! })
const claude = new Anthropic()

bot.on('session.message', async (ctx) => {
  await ctx.streamMessage(async (stream) => {
    const response = await claude.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2048,
      stream: true,
      system: 'You are a friendly assistant.',
      messages: ctx.session.context.map(m => ({ role: m.role, content: m.text })),
    })

    let inputTokens = 0, outputTokens = 0
    for await (const event of response) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        await stream.textDelta(event.delta.text)
      }
      if (event.type === 'message_start') inputTokens = event.message.usage.input_tokens
      if (event.type === 'message_delta') outputTokens = event.usage.output_tokens
    }

    await stream.finish({
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        model: 'claude-opus-4-7',
        provider: 'anthropic',
      },
    })
  })
})

bot.start()
```

### 23.3 Tool-using bot with approval

```typescript
bot.declareTools([
  {
    name: 'fetchWeather',
    description: 'Get weather for a city',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    annotations: { destructive: false, severity: 'low', requires_egress: ['api.weather.com'] },
  },
  {
    name: 'sendEmail',
    description: 'Send email on behalf of user',
    input_schema: { /* ... */ },
    annotations: { destructive: true, severity: 'high', requires_egress: ['mail.example.com'] },
  },
])

bot.on('tool_call', async (ctx, call) => {
  if (call.name === 'sendEmail') {
    const approval = await ctx.requestApproval({
      action: 'send_email',
      details: { to: call.input.to, subject: call.input.subject },
      severity: 'high',
    })
    if (approval.decision === 'deny') {
      return ctx.toolResult({ error: 'denied by user' })
    }
  }
  const result = await runTool(call.name, call.input)
  return ctx.toolResult(result)
})
```

### 23.4 Memory-aware bot

```typescript
const bot = createBot({
  token: process.env.SOPHON_TOKEN!,
  permissions: {
    memory: {
      read: ['preferences/dietary', 'preferences/cuisines'],
      write: ['preferences/cuisines', 'custom/cooking-helper/*'],
    },
  },
})

bot.on('session.message', async (ctx) => {
  const dietary = await ctx.memory.read('preferences/dietary')
  const reply = await chatWithLLM({
    system: `User is ${dietary ?? 'omnivore'}.`,
    messages: ctx.session.context,
  })
  await ctx.sendMessage(reply.text)

  // Detect and persist learned preference
  if (reply.detectedCuisine) {
    await ctx.memory.write('preferences/cuisines', reply.detectedCuisine)
  }
})
```

### 23.5 Device-capability bot

```typescript
const bot = createBot({
  token: process.env.SOPHON_TOKEN!,
  permissions: {
    device_capabilities: ['location'],
  },
})

bot.on('session.message', async (ctx) => {
  if (/restaurant|еда|food/i.test(ctx.message.text)) {
    const location = await ctx.requestDeviceCapability({
      capability: 'location',
      command: 'location.get',
      reason: 'to find nearby restaurants',
    })

    const restaurants = await searchYelp({ lat: location.lat, lng: location.lng })
    await ctx.sendMessage(`Near you: ${restaurants.map(r => r.name).join(', ')}`)
  }
})
```

---

## Changelog

- **v0.1 (2026-04-30):** Initial draft. Covers all 7 primitives. Voice mode + multi-agent threads + MCP Apps stubbed for v0.2.

---

*End of RFC v0.1.*
