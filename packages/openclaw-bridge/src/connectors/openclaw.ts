import { hostname, homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { WebSocket } from 'ws'
import { SophonClient } from '../sophon.js'
import { OpenClawClient } from '../openclaw.js'
import { Bridge } from '../bridge.js'
import { pair } from '../pair.js'
import { openBrowser } from '../browser.js'
import {
  clearCredentials,
  credentialsLocation,
  loadCredentials,
  saveCredentials,
} from '../credentials.js'
import { ExitCode } from '../exit-codes.js'
import { emit, human, isJsonMode } from '../events.js'
import { bold, brand, cyan, dim, green, red, yellow } from '../style.js'
import type { ConnectorContext, ConnectorRunner } from './types.js'

const DEFAULT_OPENCLAW_PORT = 18789
const CONNECTOR_TYPE_ID = 'openclaw'
const DEFAULT_SOPHON_BASE = 'https://api.sophon.at'

interface OpenclawArgs {
  sophonBase: string
  sophonToken: string
  openclawUrl: string
  openclawToken: string
  hostLabel: string
  manualPair: boolean
  logout: boolean
  yes: boolean
  /**
   * Per-token streaming telemetry — prints every OpenClaw delta, every
   * `sendDelta` POST round-trip, and every `sendEnd` to stderr. Off
   * by default; this is high-volume output meant for "is streaming
   * actually working" debugging. Triggered by `--debug-stream` or
   * `SOPHON_DEBUG_STREAM=1`.
   */
  debugStream: boolean
}

const OPENCLAW_USAGE = `
sophonai bridge openclaw — bridge a local OpenClaw gateway through Sophon

Usage:
  npx @sophonai/bridge openclaw [flags]

If OpenClaw is not installed on this Mac, the CLI offers to install it
(\`npm i -g openclaw@latest\`). If it is, the CLI auto-detects the local
gateway URL + token from ~/.openclaw/openclaw.json and pairs with Sophon
through your browser.

Flags:
  --sophon-base    API base URL (default https://api.sophon.at)
  --sophon-token   Sophon bot token (or SOPHON_BOT_TOKEN env). Omit on
                   first run to enter browser sign-in + pairing.
  --manual-pair    Headless fallback: print a 7-letter code for iOS.
  --logout         Delete saved Sophon credentials and exit.
  --openclaw-url   Local gateway WS URL. Auto-detected.
  --openclaw-token Gateway operator token. Auto-detected.
  --host-label     Friendly name for this host shown in Sophon Settings.
  --yes, -y        Non-interactive: auto-accept install prompts.
  --verbose, -v    Log every wire event.
  --debug-stream   Per-token streaming telemetry — prints every
                   OpenClaw delta + sendDelta round-trip + sendEnd to
                   stderr. High-volume; use only when debugging "why
                   isn't streaming working". Independent of --verbose.
  --help, -h       This help.

Env: OPENCLAW_STATE_DIR, OPENCLAW_URL, OPENCLAW_TOKEN, SOPHON_BOT_TOKEN,
     SOPHON_DEBUG_STREAM=1.
`.trim()

function parseOpenclawArgs(argv: string[]): OpenclawArgs {
  const opts: OpenclawArgs = {
    sophonBase: process.env.SOPHON_BASE_URL ?? DEFAULT_SOPHON_BASE,
    sophonToken: process.env.SOPHON_BOT_TOKEN ?? '',
    openclawUrl: process.env.OPENCLAW_URL ?? '',
    openclawToken: process.env.OPENCLAW_TOKEN ?? '',
    hostLabel: process.env.SOPHON_HOST_LABEL ?? hostname(),
    manualPair: process.env.SOPHON_MANUAL_PAIR === '1',
    logout: false,
    yes: process.env.SOPHON_YES === '1',
    debugStream: process.env.SOPHON_DEBUG_STREAM === '1',
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
    else if (a === '--yes' || a === '-y') opts.yes = true
    else if (a === '--debug-stream') opts.debugStream = true
    else if (a === '--verbose' || a === '-v') {
      // handled at dispatcher level; no-op here
    } else if (a === '--help' || a === '-h') {
      console.log(OPENCLAW_USAGE)
      process.exit(ExitCode.Ok)
    } else {
      console.error(`Unknown flag: ${a}`)
      console.error(OPENCLAW_USAGE)
      process.exit(ExitCode.Usage)
    }
  }
  return opts
}

async function detectOpenclawBinary(): Promise<string | null> {
  return new Promise((resolve) => {
    const which = spawn('which', ['openclaw'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    which.stdout.on('data', (c) => { out += c.toString() })
    which.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim())
      else resolve(null)
    })
    which.on('error', () => resolve(null))
  })
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input, output })
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase()
  rl.close()
  if (!answer) return defaultYes
  return answer === 'y' || answer === 'yes'
}

async function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (err) => {
      console.error(`failed to spawn ${cmd}: ${err}`)
      resolve(1)
    })
  })
}

async function ensureOpenclawInstalled(yes: boolean): Promise<boolean> {
  const found = await detectOpenclawBinary()
  if (found) return true

  emit('openclaw_install_required', {
    options: ['npm install -g openclaw@latest', 'brew install openclaw', 'https://openclaw.ai'],
  })

  human('')
  human(`${yellow('!')} OpenClaw is not installed on this Mac.`)
  human(dim('  Sophon bridges your local OpenClaw to the iOS app — so we need it first.'))
  human('')
  human(`${bold('Install options:')}`)
  human(`  • ${bold('npm')}   →  npm install -g openclaw@latest`)
  human(`  • ${bold('brew')}  →  brew install openclaw`)
  human(`  • ${bold('web')}   →  https://openclaw.ai`)
  human('')

  let proceed = yes
  if (!proceed) {
    // No TTY *or* JSON mode → can't prompt. Make the agent / script
    // pass --yes explicitly so we never silently install software.
    if (!input.isTTY || isJsonMode()) {
      human(`${red('✗')} Non-interactive shell. Pass ${bold('--yes')} to auto-install, or install OpenClaw manually.`)
      return false
    }
    proceed = await promptYesNo('Install openclaw now via `npm i -g openclaw@latest`?', true)
  }
  if (!proceed) {
    human(`${dim('Aborted. Install OpenClaw manually and re-run: npx @sophonai/bridge openclaw')}`)
    return false
  }

  human('')
  human(`${cyan('→')} npm install -g openclaw@latest`)
  const code = await runCommand('npm', ['install', '-g', 'openclaw@latest'])
  if (code !== 0) {
    human(`${red('✗')} npm install failed (exit ${code}).`)
    human(dim('  Try `brew install openclaw` or follow https://openclaw.ai for instructions.'))
    return false
  }
  const after = await detectOpenclawBinary()
  if (!after) {
    human(`${red('✗')} Install reported success but \`which openclaw\` still finds nothing.`)
    human(dim('  Make sure your global npm bin dir is on PATH and re-run.'))
    return false
  }
  emit('openclaw_install_done', { path: after })
  human(`${green('✓')} openclaw installed at ${dim(after)}`)
  return true
}

interface DiscoveredGateway {
  url: string
  token: string
  source: string
}

async function autodiscoverOpenclaw(): Promise<DiscoveredGateway | null> {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw')

  let cfg: any
  try {
    cfg = JSON.parse(await readFile(join(stateDir, 'openclaw.json'), 'utf8'))
  } catch {
    return null
  }

  const port =
    typeof cfg?.gateway?.port === 'number'
      ? cfg.gateway.port
      : DEFAULT_OPENCLAW_PORT
  const url = `ws://localhost:${port}`

  const cfgToken = cfg?.gateway?.auth?.token
  if (
    cfg?.gateway?.auth?.mode === 'token' &&
    typeof cfgToken === 'string' &&
    cfgToken.length > 0
  ) {
    return { url, token: cfgToken, source: `${stateDir}/openclaw.json` }
  }

  try {
    const paired = JSON.parse(
      await readFile(join(stateDir, 'nodes', 'paired.json'), 'utf8'),
    )
    for (const node of Object.values(paired ?? {})) {
      const t = (node as any)?.token
      if (typeof t === 'string' && t.length > 0) {
        return { url, token: t, source: `${stateDir}/nodes/paired.json` }
      }
    }
  } catch {}

  return null
}

async function ensureGatewayInitialized(_yes: boolean): Promise<boolean> {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw')
  if (existsSync(join(stateDir, 'openclaw.json'))) return true

  emit('error', {
    code: 'openclaw_not_initialized',
    state_dir: stateDir,
    hint: 'run `openclaw start` once to initialize, then re-invoke the bridge',
  })
  human('')
  human(`${yellow('!')} OpenClaw is installed, but the local gateway has not been initialized yet.`)
  human(`  ${dim('To start it, run:')}`)
  human(`    ${bold('openclaw start')}`)
  human(`  ${dim('Then re-run:')} ${bold('npx @sophonai/bridge openclaw')}`)
  return false
}

async function runOpenclaw(ctx: ConnectorContext): Promise<void> {
  const args = parseOpenclawArgs(ctx.argv)
  const ts = () => new Date().toISOString()
  // `--debug-stream` implies live `log` so the OpenClaw client's
  // per-frame "agent stream=… phase=… keys=…" lines show up too —
  // otherwise debug-stream only sees the bridge half of the pipeline
  // and you can't tell whether the gateway emitted any deltas at all.
  const liveLog = ctx.verbose || args.debugStream
  const log = liveLog
    ? (line: string) => process.stderr.write(`[${ts()}] ${line}\n`)
    : () => {}

  if (args.logout) {
    await clearCredentials()
    emit('shutdown', { reason: 'logout', credentials_file: credentialsLocation() })
    human(`${green('✓')} Sophon credentials removed from ${dim(credentialsLocation())}`)
    return
  }

  emit('starting', {
    connector: CONNECTOR_TYPE_ID,
    sophon_base: args.sophonBase,
    host_label: args.hostLabel,
  })
  human('')
  human(`${brand('@sophonai/bridge openclaw')} ${dim('starting…')}`)
  human('')

  const installed = await ensureOpenclawInstalled(args.yes)
  if (!installed) {
    emit('error', { code: 'openclaw_not_installed' })
    process.exit(ExitCode.OpenclawNotInstalled)
  }

  let installationId: string | undefined

  if (!args.openclawUrl || !args.openclawToken) {
    const ready = await ensureGatewayInitialized(args.yes)
    if (!ready) process.exit(ExitCode.OpenclawNotInitialized)

    const discovered = await autodiscoverOpenclaw()
    if (discovered) {
      if (!args.openclawUrl) args.openclawUrl = discovered.url
      if (!args.openclawToken) {
        args.openclawToken = discovered.token
        emit('openclaw_token_resolved', { source: discovered.source })
        log(`openclaw token resolved from ${discovered.source}`)
      }
    }
  }

  if (!args.openclawUrl) {
    args.openclawUrl = `ws://localhost:${DEFAULT_OPENCLAW_PORT}`
  }
  if (!args.openclawToken) {
    emit('error', {
      code: 'openclaw_no_token',
      tried: ['--openclaw-token', 'OPENCLAW_TOKEN', '~/.openclaw/openclaw.json', '~/.openclaw/nodes/paired.json'],
      hint: 'run `openclaw start` to initialize, or pass --openclaw-token explicitly',
    })
    human(`${red('✗')} no OpenClaw token found.`)
    human(dim(`  Tried: --openclaw-token, OPENCLAW_TOKEN env, ~/.openclaw/openclaw.json#gateway.auth.token, ~/.openclaw/nodes/paired.json.`))
    human(`  ${cyan('→')} run \`${bold('openclaw start')}\` to initialize, or pass ${bold('--openclaw-token')} explicitly.`)
    process.exit(ExitCode.OpenclawNoToken)
  }

  human(`  ${dim('sophon:')}   ${args.sophonBase}`)
  human(`  ${dim('openclaw:')} ${args.openclawUrl}`)
  human('')

  if (!args.sophonToken) {
    const saved = await loadCredentials(args.sophonBase)
    if (saved?.botToken) {
      args.sophonToken = saved.botToken
      installationId = saved.installationId
      human(`${green('✓')} loaded Sophon credentials from ${dim(credentialsLocation())}`)
    }
  }

  if (!args.sophonToken) {
    // Auto-headless: no TTY *or* JSON mode means we can't drive an
    // interactive browser flow on this machine, so default to
    // manual-pair (print a code) unless the caller already opted in.
    if (!args.manualPair && (!input.isTTY || isJsonMode())) {
      args.manualPair = true
      human(`${cyan('→')} ${dim('no TTY detected — using manual pairing (printing a code)')}`)
    }
    try {
      const result = await pair({
        sophonBase: args.sophonBase,
        connectorTypeId: CONNECTOR_TYPE_ID,
        hostLabel: args.hostLabel,
        manual: args.manualPair,
        openBrowser,
      })
      args.sophonToken = result.botToken
      installationId = result.installationId
      await saveCredentials({
        botToken: result.botToken,
        installationId: result.installationId,
        sophonBase: args.sophonBase,
      })
      human(`${green('✓')} saved Sophon credentials to ${dim(credentialsLocation())}`)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('expired')) {
        emit('error', { code: 'pairing_expired', message: msg })
        human(`${red('✗')} ${msg}`)
        human(`  ${cyan('→')} re-run \`${bold('npx @sophonai/bridge openclaw')}\` to start a new pairing window.`)
        process.exit(ExitCode.PairingExpired)
      }
      if (msg.includes('timed out')) {
        emit('error', { code: 'pairing_timeout', message: msg })
        human(`${red('✗')} ${msg}`)
        human(`  ${cyan('→')} claim the code on iPhone within 2 minutes, or use ${bold('--manual-pair')} for a code-based flow.`)
        process.exit(ExitCode.PairingTimeout)
      }
      emit('error', { code: 'pairing_failed', message: msg })
      throw err
    }
  }

  const openclaw = new OpenClawClient({
    url: args.openclawUrl,
    token: args.openclawToken,
    log,
  })
  try {
    await openclaw.connect()
  } catch (err) {
    const message = (err as Error).message
    emit('error', { code: 'openclaw_unreachable', url: args.openclawUrl, message })
    human(`${red('✗')} openclaw unreachable at ${args.openclawUrl}: ${dim(message)}`)
    human(`  ${cyan('→')} make sure \`${bold('openclaw start')}\` is running, or pass ${bold('--openclaw-url')} <ws-url>.`)
    process.exit(ExitCode.OpenclawUnreachable)
  }
  emit('openclaw_connected', { url: args.openclawUrl })
  human(`${green('✓')} openclaw connected ${dim(`(${args.openclawUrl})`)}`)

  // Wait for the *first* Sophon WS open before printing [ready], so
  // both humans and agents see a single deterministic milestone after
  // which the bridge is actually serving traffic.
  let firstSophonOpen: () => void = () => {}
  const sophonReady = new Promise<void>((resolve) => {
    firstSophonOpen = resolve
  })

  let firstReadyFired = false
  const sophon = new SophonClient({
    baseUrl: args.sophonBase,
    botToken: args.sophonToken,
    log,
    onConnected: () => {
      if (firstReadyFired) return
      firstReadyFired = true
      firstSophonOpen()
    },
  })
  const bridge = new Bridge({ sophon, openclaw, log, debugStream: args.debugStream })
  if (args.debugStream) {
    process.stderr.write(`${dim('debug-stream: ON — per-token telemetry will print to stderr')}\n`)
  }
  bridge.start()
  await sophon.start()

  // 10 s soft timeout — if Sophon hasn't accepted our token yet, warn
  // but stay in the reconnect loop. This catches the common
  // "credentials look fine but the API is unreachable" failure mode.
  const timeoutHandle = setTimeout(() => {
    if (firstReadyFired) return
    human(`${yellow('!')} still trying to reach Sophon at ${args.sophonBase} ${dim('— re-run with --verbose to see the exact failure.')}`)
  }, 10_000)

  await sophonReady
  clearTimeout(timeoutHandle)

  const installationLabel = installationId ?? 'unknown'
  emit('sophon_connected', { base_url: args.sophonBase })
  emit('ready', {
    sophon_base: args.sophonBase,
    openclaw_url: args.openclawUrl,
    installation_id: installationId ?? null,
  })
  human('')
  human(
    `${bold(green('[ready]'))} sophon=${green('connected')} openclaw=${green('connected')} installation=${bold(installationLabel)}`,
  )
  human(dim(`bridge running — Ctrl-C to stop`))

  const shutdown = (signal: string) => {
    emit('shutdown', { reason: 'signal', signal })
    human('')
    human(`${cyan('→')} caught ${bold(signal)} — shutting down`)
    sophon.stop()
    openclaw.stop()
    setTimeout(() => process.exit(ExitCode.Ok), 500)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await new Promise(() => {})
}

// ─── doctor ─────────────────────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'warn' | 'info'

interface CheckResult {
  status: CheckStatus
  label: string
  detail?: string
  hint?: string
}

function statusIcon(s: CheckStatus): string {
  switch (s) {
    case 'pass': return green('✓')
    case 'fail': return red('✗')
    case 'warn': return yellow('!')
    case 'info': return dim('·')
  }
}

function printCheck(c: CheckResult): void {
  // Always emit a structured event; the human print is suppressed
  // automatically in JSON mode by the human() helper.
  emit('doctor_check', {
    name: c.label,
    status: c.status,
    detail: c.detail ?? null,
    hint: c.hint ?? null,
  })
  const icon = statusIcon(c.status)
  const label = c.status === 'fail' ? bold(c.label) : c.label
  const head = c.detail
    ? `  ${icon} ${label} ${dim('—')} ${dim(c.detail)}`
    : `  ${icon} ${label}`
  human(head)
  if (c.hint) human(`      ${cyan('→')} ${c.hint}`)
}

async function probeWs(url: string, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve(r)
    }
    const ws = new WebSocket(url)
    const timer = setTimeout(() => done({ ok: false, detail: `timeout after ${timeoutMs}ms` }), timeoutMs)
    ws.once('open', () => {
      clearTimeout(timer)
      done({ ok: true, detail: 'reachable' })
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      const e = err as NodeJS.ErrnoException
      const detail = e.message || e.code || String(err) || 'connection failed'
      done({ ok: false, detail })
    })
  })
}

async function probeHttp(baseUrl: string, timeoutMs = 4000): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${baseUrl}/healthz`, { method: 'GET', signal: ctrl.signal })
    clearTimeout(timer)
    if (r.ok) return { ok: true, detail: `${r.status} OK` }
    return { ok: false, detail: `${r.status} ${r.statusText}` }
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, detail: (err as Error).message }
  }
}

async function doctorOpenclaw(ctx: ConnectorContext): Promise<{ ok: boolean }> {
  // Re-use arg parser so flags like --sophon-base, --openclaw-url and
  // env overrides drive the doctor checks too.
  const args = parseOpenclawArgs(ctx.argv)
  human('')
  human(`${brand('@sophonai/bridge doctor')} ${dim('— openclaw')}`)
  human('')

  const checks: CheckResult[] = []

  // 1. binary
  const bin = await detectOpenclawBinary()
  if (bin) {
    checks.push({ status: 'pass', label: 'openclaw binary on PATH', detail: bin })
  } else {
    checks.push({
      status: 'fail',
      label: 'openclaw binary on PATH',
      detail: 'not found',
      hint: 'install: npm i -g openclaw@latest  (or: brew install openclaw)',
    })
  }

  // 2. local gateway state
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw')
  const statePath = join(stateDir, 'openclaw.json')
  if (existsSync(statePath)) {
    checks.push({ status: 'pass', label: 'gateway initialized', detail: statePath })
  } else {
    checks.push({
      status: 'fail',
      label: 'gateway initialized',
      detail: `${statePath} missing`,
      hint: 'run `openclaw start` once to initialize the local gateway',
    })
  }

  // 3. token resolved
  const discovered = await autodiscoverOpenclaw()
  const resolvedUrl = args.openclawUrl || discovered?.url || `ws://localhost:${DEFAULT_OPENCLAW_PORT}`
  const resolvedToken = args.openclawToken || discovered?.token || ''
  if (resolvedToken) {
    const src = args.openclawToken
      ? '--openclaw-token / OPENCLAW_TOKEN'
      : (discovered?.source ?? 'autodetect')
    checks.push({ status: 'pass', label: 'openclaw operator token', detail: `from ${src}` })
  } else {
    checks.push({
      status: 'fail',
      label: 'openclaw operator token',
      detail: 'not resolved',
      hint: 'pass --openclaw-token, or initialize the gateway with `openclaw start`',
    })
  }

  // 4. WS reachability
  const ws = await probeWs(resolvedUrl)
  if (ws.ok) {
    checks.push({ status: 'pass', label: 'openclaw gateway reachable', detail: resolvedUrl })
  } else {
    checks.push({
      status: 'fail',
      label: 'openclaw gateway reachable',
      detail: `${resolvedUrl} — ${ws.detail}`,
      hint: 'is `openclaw start` running? try a fresh terminal and re-run.',
    })
  }

  // 5. Sophon API reachability
  const http = await probeHttp(args.sophonBase)
  if (http.ok) {
    checks.push({ status: 'pass', label: 'sophon API reachable', detail: `${args.sophonBase} (${http.detail})` })
  } else {
    checks.push({
      status: 'fail',
      label: 'sophon API reachable',
      detail: `${args.sophonBase} — ${http.detail}`,
      hint: 'check internet / proxy, or override with --sophon-base',
    })
  }

  // 6. saved credentials
  const saved = await loadCredentials(args.sophonBase)
  if (saved?.botToken) {
    const inst = saved.installationId ?? 'unknown'
    checks.push({
      status: 'pass',
      label: 'sophon credentials saved',
      detail: `${credentialsLocation()} (installation=${inst})`,
    })
  } else {
    checks.push({
      status: 'info',
      label: 'sophon credentials saved',
      detail: 'none yet — first run will pair',
      hint: 'run `npx @sophonai/bridge openclaw` to pair with Sophon',
    })
  }

  for (const c of checks) printCheck(c)

  const ok = !checks.some((c) => c.status === 'fail')
  const counts = checks.reduce(
    (a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + 1 }),
    {} as Record<CheckStatus, number>,
  )
  emit('doctor_summary', {
    ok,
    pass: counts.pass ?? 0,
    fail: counts.fail ?? 0,
    warn: counts.warn ?? 0,
    info: counts.info ?? 0,
  })
  human('')
  human(
    ok
      ? `${green('✓')} ${bold('all required checks passed')}`
      : `${red('✗')} ${bold('some checks failed')} ${dim('— see hints above')}`,
  )
  human('')
  return { ok }
}

export const openclawConnector: ConnectorRunner = {
  id: CONNECTOR_TYPE_ID,
  displayName: 'OpenClaw',
  summary: 'Bridge a local OpenClaw gateway through Sophon',
  run: runOpenclaw,
  doctor: doctorOpenclaw,
}
