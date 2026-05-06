#!/usr/bin/env node
/**
 * `npx @sophon/openclaw-bridge` entrypoint.
 *
 *   sophon-openclaw-bridge \
 *     --sophon-token <bot_token> \
 *     --openclaw-url ws://localhost:8089 \
 *     --openclaw-token <gateway_token>
 *
 * Or via env: SOPHON_BOT_TOKEN, OPENCLAW_URL, OPENCLAW_TOKEN.
 *
 * The bridge:
 *   1. Connects to Sophon (wss://api.sophon.at/v1/bot/ws) as the agent.
 *   2. Connects to your local OpenClaw gateway (ws://localhost:8089).
 *   3. Translates SAP session.message → OpenClaw chat.send → streams
 *      the reply back via sendMessageDelta + sendMessageEnd.
 */

import { hostname } from 'node:os'
import { SophonClient } from './sophon.js'
import { OpenClawClient } from './openclaw.js'
import { Bridge } from './bridge.js'
import { pair } from './pair.js'
import { openBrowser } from './browser.js'
import {
  clearCredentials,
  credentialsLocation,
  loadCredentials,
  saveCredentials,
} from './credentials.js'

interface Args {
  sophonBase: string
  sophonToken: string
  openclawUrl: string
  openclawToken: string
  hostLabel: string
  verbose: boolean
  manualPair: boolean
  logout: boolean
}

function parseArgs(argv: string[]): Args {
  const opts: Partial<Args> = {
    sophonBase: process.env.SOPHON_BASE_URL ?? 'https://api.sophon.at',
    sophonToken: process.env.SOPHON_BOT_TOKEN ?? '',
    openclawUrl: process.env.OPENCLAW_URL ?? 'ws://localhost:8089',
    openclawToken: process.env.OPENCLAW_TOKEN ?? '',
    hostLabel: process.env.SOPHON_HOST_LABEL ?? hostname(),
    verbose: process.env.VERBOSE === '1',
    manualPair: process.env.SOPHON_MANUAL_PAIR === '1',
    logout: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => argv[++i] ?? ''
    if (a === '--sophon-base') opts.sophonBase = next()
    else if (a === '--sophon-token') opts.sophonToken = next()
    else if (a === '--openclaw-url') opts.openclawUrl = next()
    else if (a === '--openclaw-token') opts.openclawToken = next()
    else if (a === '--host-label') opts.hostLabel = next()
    else if (a === '--manual-pair') opts.manualPair = true
    else if (a === '--logout') opts.logout = true
    else if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`Unknown flag: ${a}`)
      console.error(USAGE)
      process.exit(2)
    }
  }
  // sophon-token is now optional — we'll run the pairing flow if missing.
  if (!opts.logout && !opts.openclawToken) {
    console.error('--openclaw-token (or OPENCLAW_TOKEN) is required')
    process.exit(2)
  }
  return opts as Args
}

const USAGE = `
sophon-openclaw-bridge — bridge a local OpenClaw gateway through Sophon SAP

Usage (first run, paired interactively):
  npx @sophonai/openclaw \\
    --openclaw-url ws://localhost:8089 \\
    --openclaw-token <gateway_token>
  # ↑ opens Google sign-in in your browser and pairs automatically.

Usage (returning, with a saved bot token):
  npx @sophonai/openclaw \\
    --sophon-token <bot_token> \\
    --openclaw-url ws://localhost:8089 \\
    --openclaw-token <gateway_token>

Flags:
  --sophon-base    API base URL (default https://api.sophon.at)
  --sophon-token   Sophon bot token (or SOPHON_BOT_TOKEN env). Omit on
                   first run to enter browser sign-in + pairing.
  --manual-pair    Headless fallback: print a 7-letter code for iOS.
  --logout         Delete saved Sophon credentials and exit.
  --openclaw-url   Local gateway WS URL (default ws://localhost:8089)
  --openclaw-token Gateway operator token (or OPENCLAW_TOKEN env)
  --host-label     Friendly name for this host shown in Sophon Settings
                   (default: machine hostname)
  --verbose, -v    Log every wire event
  --help, -h       This help
`.trim()

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.logout) {
    await clearCredentials()
    console.error(`Sophon credentials removed from ${credentialsLocation()}`)
    return
  }
  const log = args.verbose
    ? (line: string) => console.error(`[${new Date().toISOString()}] ${line}`)
    : () => {}
  const ts = () => new Date().toISOString()

  console.error(`[${ts()}] sophon-openclaw-bridge starting`)
  console.error(`[${ts()}] sophon: ${args.sophonBase}`)
  console.error(`[${ts()}] openclaw: ${args.openclawUrl}`)

  if (!args.sophonToken) {
    const saved = await loadCredentials(args.sophonBase)
    if (saved?.botToken) {
      args.sophonToken = saved.botToken
      console.error(`[${ts()}] loaded Sophon credentials from ${credentialsLocation()}`)
    }
  }

  // No token → run browser pairing flow. Fetches a code from the
  // server, opens Google sign-in + confirmation in the browser, then
  // long-polls until the authenticated web page redeems it. The
  // resulting bot_token is saved for future runs and used below.
  if (!args.sophonToken) {
    const result = await pair({
      sophonBase: args.sophonBase,
      connectorTypeId: 'openclaw',
      hostLabel: args.hostLabel,
      manual: args.manualPair,
      openBrowser,
    })
    args.sophonToken = result.botToken
    await saveCredentials({
      botToken: result.botToken,
      installationId: result.installationId,
      sophonBase: args.sophonBase,
    })
    console.error(`[${ts()}] saved Sophon credentials to ${credentialsLocation()}`)
  }

  const openclaw = new OpenClawClient({
    url: args.openclawUrl,
    token: args.openclawToken,
    log,
  })
  await openclaw.connect()

  const sophon = new SophonClient({
    baseUrl: args.sophonBase,
    botToken: args.sophonToken,
    log,
  })
  const bridge = new Bridge({ sophon, openclaw, log })
  bridge.start()
  await sophon.start()

  console.error(`[${ts()}] bridge running — Ctrl-C to stop`)

  const shutdown = (signal: string) => {
    console.error(`[${ts()}] caught ${signal} — shutting down`)
    sophon.stop()
    openclaw.stop()
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Keep the process alive — sophon.start() returns immediately.
  await new Promise(() => {})
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
