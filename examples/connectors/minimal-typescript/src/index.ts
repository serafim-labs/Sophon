import WebSocket from 'ws'

const token = process.env.SOPHON_TOKEN
const base = process.env.SOPHON_BASE ?? 'https://api.sophon.at'
if (!token) throw new Error('SOPHON_TOKEN is required')

const wsUrl = base.replace(/^http/, 'ws') + '/v1/bridge/ws'
const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${token}` },
})

ws.on('open', () => console.log('Sophon connector connected'))
ws.on('message', async (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }))
    return
  }
  if (frame.type !== 'update') return

  const update = frame.update
  ws.send(JSON.stringify({ type: 'ack', up_to_update_id: update.update_id }))
  if (update.type !== 'session.message') return

  const sessionId = update.session_id
  const interactionId = update.interaction_id
  const text = update.payload?.message?.text ?? ''
  const reply = `Echo from connector: ${text}`

  const message = await post('/v1/bridge/sendMessage', {
    session_id: sessionId,
    interaction_id: interactionId,
    text: '',
    idempotency_key: `${interactionId}:message`,
  })

  for (const chunk of chunkText(reply, 24)) {
    await post('/v1/bridge/sendMessageDelta', {
      message_id: message.message_id ?? message.id,
      delta: chunk,
      idempotency_key: `${interactionId}:delta:${chunk}`,
    })
  }

  await post('/v1/bridge/sendMessageEnd', {
    message_id: message.message_id ?? message.id,
    text: reply,
    finish_reason: 'stop',
    idempotency_key: `${interactionId}:end`,
  })
})

ws.on('close', (code, reason) => {
  console.error('Sophon connector closed', code, reason.toString())
  process.exit(1)
})

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) {
    throw new Error(`${path} failed: ${res.status} ${JSON.stringify(json)}`)
  }
  return json.result ?? json
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}
