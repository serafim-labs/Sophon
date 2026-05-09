/**
 * Verify SAP webhook signatures (Stripe-compat HMAC-SHA256).
 *
 * Header shape: `t=<unix_ts>,v1=<HMAC-SHA256-hex>`
 * Signed payload: `<timestamp>.<raw_body>`
 *
 * MUST be called with the RAW request body (before any JSON parse), or
 * any byte difference (whitespace, key order) will fail verification.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifyResult {
  ok: boolean
  reason?: string
}

export function verifyWebhookSignature(opts: {
  rawBody: string
  signatureHeader: string | null | undefined
  timestampHeader: string | null | undefined
  secret: string
  toleranceSeconds?: number
}): VerifyResult {
  const { rawBody, signatureHeader, timestampHeader, secret } = opts
  const tolerance = opts.toleranceSeconds ?? 300

  if (!secret || secret.length < 32) {
    return { ok: false, reason: 'webhook_secret_too_short' }
  }
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' }
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp' }

  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts)
  if (skew > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' }

  let claimed: string | null = null
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.trim().split('=')
    if (k === 'v1' && v) claimed = v
  }
  if (!claimed) return { ok: false, reason: 'malformed_signature' }

  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  try {
    if (!timingSafeEqual(Buffer.from(claimed, 'hex'), Buffer.from(expected, 'hex'))) {
      return { ok: false, reason: 'mismatch' }
    }
  } catch {
    return { ok: false, reason: 'mismatch' }
  }
  return { ok: true }
}
