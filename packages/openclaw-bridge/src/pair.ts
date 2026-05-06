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
 * No external deps — uses fetch, plain-text rendering. QR rendering
 * deferred to a follow-up so we don't pull in qrcode-terminal yet.
 */

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
   * Override the printer for testing. Defaults to console.error so the
   * pairing UX doesn't pollute stdout (which we keep clean for piping).
   */
  print?: (line: string) => void
  openBrowser?: (url: string) => Promise<boolean>
}

/** Long-poll wait, in seconds (server clamps to 25). */
const POLL_TIMEOUT_SEC = 25

export async function pair(opts: PairOptions): Promise<PairingResult> {
  const print = opts.print ?? ((line: string) => console.error(line))

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

  // 2. Open browser auth by default. Manual code remains the
  // headless/SSH fallback via --manual-pair.
  print('')
  print(`  Pair this ${connector.display_name} bridge with Sophon`)
  print('')
  if (!opts.manual && browser_url) {
    const opened = opts.openBrowser ? await opts.openBrowser(browser_url) : false
    if (opened) {
      print('  Opened your browser to finish Google sign-in + pairing.')
      print('')
    } else {
      print('  Open this URL to finish Google sign-in + pairing:')
      print(`  ${browser_url}`)
      print('')
    }
    print(`  Waiting for confirmation… link expires in ${ttlSec}s.`)
    print('')
  } else {
    print(`      ┌─────────────┐`)
    print(`      │   ${code}   │`)
    print(`      └─────────────┘`)
    print('')
    print(`  Open Sophon on iPhone → tap "Connect ${connector.display_name}" →`)
    print(`  paste the 7-letter code. Code expires in ${ttlSec}s.`)
    print('')
  }

  // 3. Poll until claimed/expired
  const startedAt = Date.now()
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
      print(`  ✓ paired — installation ${installation_id}`)
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
