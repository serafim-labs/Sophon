/**
 * Anonymous pairing flow: CLI ↔ Sophon /v1/pairing/* endpoints.
 *
 * Flow (CONNECTOR_ARCHITECTURE.md §3.2):
 *   1. POST /v1/pairing/start { connector_type_id }
 *      → { code, expires_at, install_command, install_steps_md }
 *   2. Print code (and a Crockford-32 QR-ish callout) for the user.
 *   3. Long-poll GET /v1/pairing/poll?code=…&timeout=25000 in a loop
 *      until status flips to 'claimed' (user redeemed on iOS) or
 *      'expired' (TTL hit, ~120 s).
 *   4. Return { botToken, sophonWsUrl, installationId } so the bridge
 *      can connect with the freshly-minted token.
 *
 * UX touches:
 *   - In interactive mode (TTY, not --json) we print a `still waiting…`
 *     ticker every 15 s so the user isn't staring at dead air for the
 *     full 2-minute window.
 *   - In --json mode we emit pairing_started / pairing_browser_opened /
 *     pairing_waiting / pairing_claimed events so an agent driving the
 *     CLI can render its own progress UI.
 */

import { emit, human, isJsonMode } from './events.js'
import { bold, cyan, dim, green, spinner } from './style.js'

export interface PairingResult {
  botToken: string
  sophonWsUrl: string
  installationId: string
}

export interface PairOptions {
  sophonBase: string
  connectorTypeId: string
  hostLabel?: string
  manual?: boolean
  /**
   * Override the printer for testing. Defaults to the global human()
   * helper, which writes to stderr unless --json is set.
   */
  print?: (line: string) => void
  openBrowser?: (url: string) => Promise<boolean>
}

/** Long-poll wait, in seconds (server clamps to 25). */
const POLL_TIMEOUT_SEC = 25
/** How often to emit a `pairing_waiting` event in --json mode. */
const TICKER_MS = 15_000

export async function pair(opts: PairOptions): Promise<PairingResult> {
  const print = opts.print ?? ((line: string) => human(line))

  // 1. Start
  const startResp = await fetch(`${opts.sophonBase}/v1/pairing/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      connector_type_id: opts.connectorTypeId,
      ...(opts.hostLabel ? { host_label: opts.hostLabel } : {}),
    }),
  })
  if (!startResp.ok) {
    const body = await startResp.text().catch(() => '')
    throw new Error(`pairing/start failed: ${startResp.status} ${body}`)
  }
  const startBody = (await startResp.json()) as {
    ok: boolean
    result?: {
      code: string
      expires_at: number
      browser_url?: string
      install_command: string
      install_steps_md: string
      connector: { id: string; display_name: string }
    }
    error?: { code: string }
  }
  if (!startBody.ok || !startBody.result) {
    throw new Error(`pairing/start error: ${startBody.error?.code ?? 'unknown'}`)
  }
  const { code, expires_at, connector, browser_url } = startBody.result
  const ttlSec = Math.max(0, Math.round((expires_at - Date.now()) / 1000))

  emit('pairing_started', {
    connector: connector.id,
    code,
    expires_at,
    ttl_sec: ttlSec,
    browser_url: browser_url ?? null,
    mode: opts.manual ? 'manual' : 'browser',
  })

  // 2. Open browser auth by default. Manual code remains the
  // headless/SSH fallback via --manual-pair.
  print('')
  print(`  ${bold('Pair this ' + connector.display_name + ' bridge with Sophon')}`)
  print('')
  if (!opts.manual && browser_url) {
    const opened = opts.openBrowser ? await opts.openBrowser(browser_url) : false
    if (opened) {
      emit('pairing_browser_opened', { browser_url })
      print(`  ${green('✓')} Opened your browser to finish Google sign-in + pairing.`)
      print('')
    } else {
      print(`  Open this URL to finish Google sign-in + pairing:`)
      print(`  ${cyan(browser_url)}`)
      print('')
    }
  } else {
    // Big bold code in a dim-grey box. The code itself is the only
    // thing that needs to read clearly across kitten/iTerm/macOS Term.
    const inner = `   ${code}   `
    const rule = '─'.repeat(inner.length)
    print('      ' + dim('┌' + rule + '┐'))
    print('      ' + dim('│') + bold(inner) + dim('│'))
    print('      ' + dim('└' + rule + '┘'))
    print('')
    print(`  Open Sophon on iPhone → tap "${bold('Connect ' + connector.display_name)}" →`)
    print(`  paste the 7-letter code. ${dim('Code expires in ' + ttlSec + 's.')}`)
    print('')
  }

  // 2b. Interactive spinner — gives the user a continuously-animated
  // line so they can tell we're still alive without dropping into
  // --verbose. JSON mode emits a structured `pairing_waiting` event
  // every TICKER_MS instead.
  const startedAt = Date.now()
  const remainingLabel = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    const remaining = Math.max(0, ttlSec - elapsed)
    return `${dim('Waiting for confirmation… link expires in')} ${bold(remaining + 's')}${dim('.')}`
  }

  const spin = !isJsonMode() ? spinner(remainingLabel()) : null
  let spinTick: ReturnType<typeof setInterval> | null = null
  if (spin) {
    spinTick = setInterval(() => spin.update(remainingLabel()), 1000)
  }

  let jsonTick: ReturnType<typeof setInterval> | null = null
  if (isJsonMode()) {
    jsonTick = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      emit('pairing_waiting', { elapsed_sec: elapsed, remaining_sec: Math.max(0, ttlSec - elapsed) })
    }, TICKER_MS)
  }

  const stopTicker = () => {
    if (spinTick) clearInterval(spinTick)
    if (jsonTick) clearInterval(jsonTick)
    spinTick = null
    jsonTick = null
    spin?.stop()
  }

  try {
    // 3. Poll until claimed/expired
    while (true) {
      if (Date.now() - startedAt > 120_000) {
        throw new Error('pairing window timed out (120s)')
      }
      const url = new URL(`${opts.sophonBase}/v1/pairing/poll`)
      url.searchParams.set('code', code)
      url.searchParams.set('timeout', String(POLL_TIMEOUT_SEC))
      let pollResp: Response
      try {
        pollResp = await fetch(url, { method: 'GET' })
      } catch (err) {
        // Network blip — retry quickly.
        await sleep(500)
        continue
      }
      if (!pollResp.ok) {
        const body = await pollResp.text().catch(() => '')
        throw new Error(`pairing/poll failed: ${pollResp.status} ${body}`)
      }
      const body = (await pollResp.json()) as {
        ok: boolean
        result?: {
          status: 'pending' | 'claimed' | 'expired'
          bot_token?: string
          installation_id?: string
          sophon_ws_url?: string
        }
        error?: { code: string }
      }
      if (!body.ok || !body.result) {
        throw new Error(`pairing/poll error: ${body.error?.code ?? 'unknown'}`)
      }
      const status = body.result.status
      if (status === 'claimed') {
        const { bot_token, installation_id, sophon_ws_url } = body.result
        if (!bot_token || !installation_id || !sophon_ws_url) {
          throw new Error('pairing/poll claimed but missing fields')
        }
        emit('pairing_claimed', { installation_id })
        // Stop the spinner *before* printing the success line so the
        // checkmark lands on its own row, not over the spinner's last frame.
        stopTicker()
        print(`  ${green('✓')} paired ${dim('— installation')} ${bold(installation_id)}`)
        print('')
        return {
          botToken: bot_token,
          sophonWsUrl: sophon_ws_url,
          installationId: installation_id,
        }
      }
      if (status === 'expired') {
        throw new Error(`pairing code ${code} expired before claim`)
      }
      // 'pending' — long-poll already waited up to POLL_TIMEOUT_SEC, loop.
    }
  } finally {
    stopTicker()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
