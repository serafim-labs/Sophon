import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const token = process.env.SOPHON_TOKEN
const base = process.env.SOPHON_BASE ?? 'https://api.sophon.at'
const command = process.env.AGENT_COMMAND
if (!token) throw new Error('SOPHON_TOKEN is required')
if (!command) throw new Error('AGENT_COMMAND is required')

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/bridge/ws', {
  headers: { Authorization: `Bearer ${token}` },
})

ws.on('message', async (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }))
  if (frame.type !== 'update') return

  const update = frame.update
  ws.send(JSON.stringify({ type: 'ack', up_to_update_id: update.update_id }))
  if (update.type !== 'session.message') return

  const text = update.payload?.message?.text ?? ''
  const msg = await post('/v1/bridge/sendMessage', {
    session_id: update.session_id,
    interaction_id: update.interaction_id,
    text: '',
    idempotency_key: `${update.interaction_id}:message`,
  })
  const messageId = msg.message_id ?? msg.id

  let final = ''
  const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(text)
  child.stdout.on('data', async (buf: Buffer) => {
    const delta = buf.toString()
    final += delta
    await post('/v1/bridge/sendMessageDelta', {
      message_id: messageId,
      delta,
      idempotency_key: `${update.interaction_id}:stdout:${final.length}`,
    })
  })
  child.stderr.on('data', (buf) => console.error(buf.toString()))
  child.on('close', async (code) => {
    await post('/v1/bridge/sendMessageEnd', {
      message_id: messageId,
      text: final || `Command exited with ${code}`,
      finish_reason: code === 0 ? 'stop' : 'error',
      idempotency_key: `${update.interaction_id}:end`,
    })
  })
})

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) throw new Error(`${path} failed: ${res.status}`)
  return json.result ?? json
}
