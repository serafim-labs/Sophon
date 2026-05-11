import { describe, it, expect } from 'vitest'
import { humanizeRunError, formatRunErrorForChat } from './error-messages.js'

describe('humanizeRunError', () => {
  it('catches expired anthropic OAuth profile', () => {
    const out = humanizeRunError('Error: No credentials found for profile "anthropic:claude-cli".')
    expect(out).toMatch(/Anthropic/)
    expect(out).toMatch(/claude/)
    expect(out).toMatch(/openrouter\/auto/)
  })

  it('catches missing creds for any other provider', () => {
    const out = humanizeRunError('No credentials found for profile "openai:default".')
    expect(out).toMatch(/openai:default/)
    expect(out).toMatch(/auth login/)
  })

  it('catches the bare "not connected" string from the openclaw client', () => {
    const out = humanizeRunError('not connected')
    expect(out).toMatch(/not connected/i)
    expect(out).toMatch(/bridge service status/)
  })

  it('catches openclaw_unreachable', () => {
    const out = humanizeRunError('openclaw_unreachable')
    expect(out).toMatch(/not connected/i)
  })

  it('catches HTTP 5xx upstream', () => {
    const out = humanizeRunError(
      'HTTP 500: Internal Server Error; provider="openrouter" model="anthropic/claude-opus-4.6"',
    )
    expect(out).toMatch(/didn't respond|timeout|5xx/i)
    expect(out).toMatch(/openrouter\/auto/)
  })

  it('catches idle-timeout from the llm watchdog', () => {
    const out = humanizeRunError('[llm-idle-timeout] anthropic/claude-opus-4.6 produced no reply')
    expect(out).toMatch(/didn't respond|timeout/i)
  })

  it('catches missing dist chunks (broken openclaw install)', () => {
    const out = humanizeRunError(
      "Cannot find module '/opt/homebrew/lib/node_modules/openclaw/dist/bash-tools-Xyz.js'",
    )
    expect(out).toMatch(/Broken OpenClaw install/i)
    expect(out).toMatch(/npm i -g openclaw/)
  })

  it('catches WS protocol mismatch with newer openclaw', () => {
    const out = humanizeRunError('INVALID_REQUEST protocol mismatch')
    expect(out).toMatch(/protocol mismatch/i)
  })

  it('catches rate-limit responses', () => {
    expect(humanizeRunError('HTTP 429: Too Many Requests')).toMatch(/rate-limit/i)
    expect(humanizeRunError('rate_limit_exceeded')).toMatch(/rate-limit/i)
  })

  it('caps very long fallback messages', () => {
    const huge = 'x'.repeat(800)
    const out = humanizeRunError(huge)
    expect(out.length).toBeLessThan(440)
    expect(out).toMatch(/OpenClaw error:/)
  })

  it('handles Error objects, not just strings', () => {
    const out = humanizeRunError(new Error('not connected'))
    expect(out).toMatch(/not connected/i)
  })

  it('formatRunErrorForChat returns the humanized text without decoration', () => {
    const out = formatRunErrorForChat('not connected')
    expect(out).not.toMatch(/⚠️|❌|🚨/)
    expect(out).toMatch(/not connected/i)
  })
})
