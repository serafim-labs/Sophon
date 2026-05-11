/**
 * Humanize raw error strings coming out of OpenClaw / the connector
 * before they hit the chat bubble. Goal: explain WHAT happened and
 * WHAT to do — not just leak the underlying stack trace verbatim.
 *
 * Order matters: more-specific patterns first. `formatRunErrorForChat`
 * is the entry point used by bridge.ts.
 */

export function humanizeRunError(raw: unknown): string {
  const msg = typeof raw === 'string' ? raw : (raw as Error)?.message ?? String(raw)
  const lower = msg.toLowerCase()

  // ── auth / credentials ───────────────────────────────────────────
  if (/no credentials found for profile/i.test(msg)) {
    const profile = msg.match(/profile "([^"]+)"/i)?.[1] ?? 'unknown'
    if (profile.startsWith('anthropic:')) {
      return (
        `Anthropic auth token is missing or expired (profile \`${profile}\`).\n` +
        `Fix: run \`claude\` in a terminal to refresh OAuth, or switch provider:\n` +
        `\`openclaw models set openrouter/auto\``
      )
    }
    return (
      `Missing credentials for provider \`${profile}\`.\n` +
      `Run \`openclaw models auth login\`, or pick a different model: \`openclaw models set <model>\`.`
    )
  }

  // ── connectivity to local openclaw gateway ───────────────────────
  if (lower === 'not connected' || /openclaw[_ ]unreachable/i.test(msg)) {
    return (
      `Bridge is not connected to the local OpenClaw gateway.\n` +
      `Check: \`bridge service status\` and \`launchctl list | grep openclaw\`.\n` +
      `Restart: \`launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway\`.`
    )
  }

  // ── upstream LLM provider failures (OpenRouter / Bedrock / etc) ──
  if (/HTTP 5\d\d/.test(msg) || /provider.*timeout/i.test(msg) || /idle-?timeout/i.test(lower)) {
    const provider = msg.match(/provider[":\s]+["']?([a-z0-9_-]+)/i)?.[1]
    const model = msg.match(/model[":\s]+["']?([a-z0-9/_.\-]+)/i)?.[1]
    const where = provider && model ? `${provider}/${model}` : provider || model || 'upstream'
    return (
      `The LLM provider (${where}) didn't respond (timeout / 5xx).\n` +
      `Try again, or switch model: \`openclaw models set openrouter/auto\`.`
    )
  }

  // ── broken openclaw install (missing dist chunks) ────────────────
  if (/Cannot find module.*\/openclaw\//i.test(msg) || /ERR_MODULE_NOT_FOUND/.test(msg)) {
    return (
      `Broken OpenClaw install (missing dist chunks).\n` +
      `Reinstall: \`rm -rf $(npm root -g)/openclaw && npm i -g openclaw@latest\`.`
    )
  }

  // ── protocol mismatch with the local openclaw ────────────────────
  if (/protocol[_ ]mismatch/i.test(msg) || /INVALID_REQUEST.*protocol/i.test(msg)) {
    return (
      `OpenClaw version is incompatible with this bridge (WS protocol mismatch).\n` +
      `Downgrade OpenClaw to a compatible release, or upgrade the bridge.`
    )
  }

  // ── rate limit ───────────────────────────────────────────────────
  if (/rate.?limit/i.test(msg) || /HTTP 429/.test(msg) || /too many requests/i.test(lower)) {
    return `Provider returned a rate-limit. Wait a bit and try again.`
  }

  // ── tool/plugin error fallback ───────────────────────────────────
  if (/^\[tools\]/.test(msg) && /Cannot find module/i.test(msg)) {
    const tool = msg.match(/^\[tools\] (\w+) failed/)?.[1] ?? 'tool'
    return (
      `Tool \`${tool}\` failed to load (broken OpenClaw dist).\n` +
      `Reinstall OpenClaw: \`npm i -g openclaw@latest\`.`
    )
  }

  // ── generic fallback: keep the raw message but cap it ────────────
  const trimmed = msg.length > 400 ? msg.slice(0, 400) + '…' : msg
  return `OpenClaw error: ${trimmed}`
}

/** Entry point used by bridge.ts when rendering the failed-turn bubble. */
export function formatRunErrorForChat(raw: unknown): string {
  return humanizeRunError(raw)
}
