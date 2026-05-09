/**
 * SAP wire types — minimum needed for W3 echo bot.
 *
 * Full type coverage lands as we implement W5 (streaming), W7 (tools),
 * W8 (memory), W9 (capabilities). For now this is the minimum surface.
 */

export interface SAPMessageContext {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string | null
  ts: number
}

export interface SAPSession {
  id: string
  context: SAPMessageContext[]
}

export interface SAPInstallation {
  id: string
  permissions?: {
    memory_read?: string[]
    memory_write?: string[]
    device_capabilities?: string[]
  }
}

export interface SAPUser {
  id: string
  display_name?: string | null
  image?: string | null
  locale?: string
  platform?: string
}

export interface SAPMessage {
  id: string
  text: string
  attachments?: unknown[]
  thought_level?: 'default' | 'extended' | 'max'
  reply_to?: string
}

export type SAPUpdate =
  | {
      update_id: number
      agent_id: string
      ts: number
      type: 'session.message'
      interaction_id: string
      session: SAPSession
      installation: SAPInstallation
      user: SAPUser
      message: SAPMessage
    }
  | {
      update_id: number
      agent_id: string
      ts: number
      type: 'session.started'
      session: { id: string }
      installation: SAPInstallation
      user: SAPUser
    }
  | {
      update_id: number
      agent_id: string
      ts: number
      type: 'session.cancelled'
      session: { id: string }
      reason: string
      interaction_id?: string
    }
  | {
      update_id: number
      agent_id: string
      ts: number
      type: 'installation.created'
      installation: SAPInstallation
      user?: SAPUser
    }
  | {
      update_id: number
      agent_id: string
      ts: number
      type: 'installation.revoked'
      installation: { id: string }
      reason: string
    }

export type SAPMethodAck = { method: 'ack' }
export type SAPMethodSendMessage = {
  method: 'sendMessage'
  session_id: string
  text: string
  interaction_id?: string
  attachments?: unknown[]
  reply_to?: string
  idempotency_key: string
  usage?: {
    input_tokens: number
    output_tokens: number
    estimated_cost_usd?: number
    model?: string
    provider?: string
  }
}

export type SAPMethodResponse = SAPMethodAck | SAPMethodSendMessage

export interface SAPMethodResult<T = unknown> {
  ok: boolean
  result?: T
  error?: { code: string; message?: string; details?: unknown }
}
