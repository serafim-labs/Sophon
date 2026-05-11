/**
 * macOS LaunchAgent installer for the bridge.
 *
 * Mirrors what `openclaw gateway install` does for the OpenClaw gateway:
 * writes a plist under ~/Library/LaunchAgents, asks launchd to bootstrap
 * it into the GUI session, and lets KeepAlive keep the process up across
 * crashes and logouts. Once installed, the user no longer has to keep a
 * terminal open with `npx @sophonai/bridge openclaw` running.
 *
 * Surface (subcommands of `bridge service`):
 *   install [--force]     write plist + bootstrap + kickstart
 *   uninstall             bootout + remove plist
 *   status                launchctl print → state/pid/last-exit
 *   restart               kickstart -k
 *   logs [-f] [-n N]      print log paths, or tail -F
 *
 * macOS-only for now. Linux (systemd --user) and Windows (Task Scheduler)
 * land later.
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExitCode } from './exit-codes.js'
import { credentialsLocation } from './credentials.js'
import { emit, human, isJsonMode } from './events.js'
import { bold, brand, cyan, dim, green, red, yellow } from './style.js'

const LAUNCH_AGENT_LABEL = 'at.sophon.bridge'
const LAUNCH_AGENT_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = join(LAUNCH_AGENT_DIR, `${LAUNCH_AGENT_LABEL}.plist`)
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'sophon-bridge')
const STDOUT_LOG = join(LOG_DIR, 'out.log')
const STDERR_LOG = join(LOG_DIR, 'err.log')

const PLIST_THROTTLE_SECONDS = 1
const PLIST_UMASK_DECIMAL = 0o077

// Env vars we forward into the LaunchAgent so `bridge openclaw` under
// launchd sees the same configuration the user paired with. HOME/PATH
// are added unconditionally; the rest are pass-through-if-set.
const PASS_THROUGH_ENV = [
  'SOPHON_BASE_URL',
  'SOPHON_HOST_LABEL',
  'SOPHON_CONFIG_DIR',
  'SOPHON_DEBUG_STREAM',
  'OPENCLAW_URL',
  'OPENCLAW_TOKEN',
  'OPENCLAW_STATE_DIR',
  'NO_COLOR',
] as const

interface LaunchctlResult {
  code: number
  stdout: string
  stderr: string
}

function isMac(): boolean {
  return process.platform === 'darwin'
}

function guiDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501
  return `gui/${uid}`
}

function serviceTarget(): string {
  return `${guiDomain()}/${LAUNCH_AGENT_LABEL}`
}

async function execLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return execCapture('launchctl', args)
}

function execCapture(file: string, args: string[], opts: SpawnOptions = {}): Promise<LaunchctlResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    child.stdout?.on('data', (c) => { stdout += c.toString() })
    child.stderr?.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: stderr || String(err) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function plistEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function buildPlist(args: {
  programArguments: string[]
  workingDirectory: string
  stdoutPath: string
  stderrPath: string
  environment: Record<string, string>
}): string {
  const argsXml = args.programArguments
    .map((a) => `\n      <string>${plistEscape(a)}</string>`)
    .join('')
  const envEntries = Object.entries(args.environment)
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(
      ([k, v]) =>
        `\n      <key>${plistEscape(k)}</key>\n      <string>${plistEscape(v)}</string>`,
    )
    .join('')
  const envXml = envEntries
    ? `\n    <key>EnvironmentVariables</key>\n    <dict>${envEntries}\n    </dict>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(LAUNCH_AGENT_LABEL)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${PLIST_THROTTLE_SECONDS}</integer>
    <key>Umask</key>
    <integer>${PLIST_UMASK_DECIMAL}</integer>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${plistEscape(args.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${plistEscape(args.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(args.stderrPath)}</string>${envXml}
  </dict>
</plist>
`
}

interface ParsedLaunchctlPrint {
  state?: string
  pid?: number
  lastExitCode?: number
  lastExitReason?: string
}

function parseLaunchctlPrint(output: string): ParsedLaunchctlPrint {
  const out: ParsedLaunchctlPrint = {}
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (key === 'state') out.state = value
    else if (key === 'pid') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n) && n > 0) out.pid = n
    } else if (key === 'last exit code') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) out.lastExitCode = n
    } else if (key === 'last exit reason') {
      out.lastExitReason = value
    }
  }
  return out
}

interface ServiceState {
  installed: boolean
  loaded: boolean
  running: boolean
  pid?: number
  state?: string
  lastExitCode?: number
  lastExitReason?: string
  detail?: string
  plistPath: string
  stdoutPath: string
  stderrPath: string
}

async function gatherState(): Promise<ServiceState> {
  const installed = existsSync(PLIST_PATH)
  const print = await execLaunchctl(['print', serviceTarget()])
  const loaded = print.code === 0
  let running = false
  let parsed: ParsedLaunchctlPrint = {}
  if (loaded) {
    parsed = parseLaunchctlPrint(print.stdout || print.stderr || '')
    running =
      (typeof parsed.pid === 'number' && parsed.pid > 0) ||
      (parsed.state ?? '').toLowerCase() === 'running'
  }
  // Pull stdout/stderr paths from the live plist if it exists, else fall
  // back to our defaults. Lets callers `tail` the right file even if the
  // user customised paths in a previous install.
  let stdoutPath = STDOUT_LOG
  let stderrPath = STDERR_LOG
  if (installed) {
    try {
      const text = await readFile(PLIST_PATH, 'utf8')
      const o = text.match(/<key>StandardOutPath<\/key>\s*<string>([\s\S]*?)<\/string>/)
      const e = text.match(/<key>StandardErrorPath<\/key>\s*<string>([\s\S]*?)<\/string>/)
      if (o?.[1]) stdoutPath = decodePlistString(o[1])
      if (e?.[1]) stderrPath = decodePlistString(e[1])
    } catch {}
  }
  return {
    installed,
    loaded,
    running,
    pid: parsed.pid,
    state: parsed.state,
    lastExitCode: parsed.lastExitCode,
    lastExitReason: parsed.lastExitReason,
    detail: !loaded ? (print.stderr || print.stdout).trim() || undefined : undefined,
    plistPath: PLIST_PATH,
    stdoutPath,
    stderrPath,
  }
}

function decodePlistString(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
    .trim()
}

function resolveCliPath(): string {
  // dist/service.js → dist/cli.js. Pinned at install time so a
  // global-install upgrade is a deliberate `service install --force`,
  // not a silent in-place swap.
  const here = fileURLToPath(import.meta.url)
  return join(dirname(here), 'cli.js')
}

function looksLikeNpxCachePath(path: string): boolean {
  // npx caches under ~/.npm/_npx/<hash>/... and prunes them. Pinning a
  // plist to that path leads to "service stops working two days later
  // for no reason" — refuse to install.
  return path.includes('/_npx/') || path.includes('/.npm/_cacache/')
}

function buildEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
  }
  for (const key of PASS_THROUGH_ENV) {
    const v = process.env[key]
    if (typeof v === 'string' && v.length > 0) env[key] = v
  }
  return env
}

async function ensureSecureDir(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode })
}

async function plistWriteAndStage(args: {
  programArguments: string[]
  environment: Record<string, string>
}): Promise<void> {
  await ensureSecureDir(LAUNCH_AGENT_DIR, 0o755)
  await ensureSecureDir(LOG_DIR, 0o755)
  const plist = buildPlist({
    programArguments: args.programArguments,
    workingDirectory: homedir(),
    stdoutPath: STDOUT_LOG,
    stderrPath: STDERR_LOG,
    environment: args.environment,
  })
  await writeFile(PLIST_PATH, plist, { encoding: 'utf8', mode: 0o644 })
}

async function bootoutSilent(): Promise<void> {
  // Best-effort cleanup. `bootout <plist>` is the form that works even
  // when the service was registered against an older plist on disk.
  await execLaunchctl(['bootout', guiDomain(), PLIST_PATH])
  // Belt-and-braces — bootout-by-target catches the case where the plist
  // path drifted between install runs.
  await execLaunchctl(['bootout', serviceTarget()])
}

async function bootstrap(): Promise<void> {
  // `disable` state survives plist rewrites; clear it before bootstrap
  // or KeepAlive=true silently has no effect.
  await execLaunchctl(['enable', serviceTarget()])
  const boot = await execLaunchctl(['bootstrap', guiDomain(), PLIST_PATH])
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim()
    const norm = detail.toLowerCase()
    if (
      norm.includes('domain does not support specified action') ||
      norm.includes('bootstrap failed: 125')
    ) {
      throw new Error(
        [
          `launchctl bootstrap failed: ${detail}`,
          `LaunchAgent install requires a logged-in macOS GUI session for this user (${guiDomain()}).`,
          `If you ran this over SSH or with sudo: sign in to the macOS desktop as ${userInfo().username} and rerun.`,
        ].join('\n'),
      )
    }
    throw new Error(`launchctl bootstrap failed: ${detail || `exit ${boot.code}`}`)
  }
}

async function kickstart(): Promise<void> {
  const r = await execLaunchctl(['kickstart', '-k', serviceTarget()])
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim()
    throw new Error(`launchctl kickstart failed: ${detail || `exit ${r.code}`}`)
  }
}

async function moveToTrash(plistPath: string): Promise<string | null> {
  const trashDir = join(homedir(), '.Trash')
  const dest = join(trashDir, `${LAUNCH_AGENT_LABEL}.plist`)
  try {
    await mkdir(trashDir, { recursive: true })
    await rename(plistPath, dest)
    return dest
  } catch {
    try {
      await rm(plistPath, { force: true })
      return null
    } catch {
      return null
    }
  }
}

// ─── subcommands ─────────────────────────────────────────────────────

const SERVICE_USAGE = `
sophonai bridge service — run the bridge under launchd so the terminal can close

Usage:
  npx @sophonai/bridge service <command> [flags]

Commands:
  install [--force]    write LaunchAgent plist and bootstrap it into launchd
  uninstall            bootout + remove the plist (move to ~/.Trash)
  status               print loaded/running state, PID, last exit
  restart              launchctl kickstart -k (force-restart the live unit)
  logs [-f] [-n N]     print log paths or tail the stdout/stderr files

Flags:
  --force              re-install even if already loaded (install only)
  -f, --follow         tail -F instead of printing (logs only)
  -n, --lines <N>      lines of history to print (logs only, default 50)
  --help, -h           this help

Notes:
  • macOS only. Linux (systemd --user) and Windows lands later.
  • Run \`npx @sophonai/bridge openclaw\` once first to pair — the service
    inherits the saved Sophon credentials at ~/.config/sophon/credentials.json.
  • \`openclaw gateway install\` (the OpenClaw side) needs to run separately
    if you also want the gateway itself to auto-start. The bridge is the
    network-edge piece; the gateway is the agent runtime.
`.trim()

interface ServiceArgs {
  force: boolean
  follow: boolean
  lines: number
}

function parseServiceArgs(argv: string[]): ServiceArgs {
  const opts: ServiceArgs = { force: false, follow: false, lines: 50 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--force') opts.force = true
    else if (a === '-f' || a === '--follow') opts.follow = true
    else if (a === '-n' || a === '--lines') {
      const n = Number.parseInt(argv[++i] ?? '', 10)
      if (Number.isFinite(n) && n > 0) opts.lines = n
    } else if (a === '--help' || a === '-h') {
      console.log(SERVICE_USAGE)
      process.exit(ExitCode.Ok)
    }
  }
  return opts
}

function failPlatform(): never {
  emit('error', {
    code: 'service_unsupported_platform',
    platform: process.platform,
    hint: 'macOS only for now. Run `bridge openclaw` in a persistent shell, or supervise via your own process manager.',
  })
  human(`${red('✗')} \`service\` is macOS-only right now (current: ${process.platform}).`)
  human(dim(`  Linux (systemd --user) and Windows are coming. Until then run \`bridge openclaw\` under your own supervisor.`))
  process.exit(ExitCode.Runtime)
}

export async function runService(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    if (isJsonMode()) {
      process.stdout.write(JSON.stringify({
        event: 'help',
        scope: 'service',
        commands: ['install', 'uninstall', 'status', 'restart', 'logs'],
        flags: ['--force', '--follow', '--lines'],
      }) + '\n')
    } else {
      console.log(SERVICE_USAGE)
    }
    process.exit(ExitCode.Ok)
  }

  if (!isMac()) failPlatform()

  const rest = argv.slice(1)
  const opts = parseServiceArgs(rest)

  switch (sub) {
    case 'install':
      await serviceInstall(opts)
      return
    case 'uninstall':
      await serviceUninstall()
      return
    case 'status':
      await serviceStatus()
      return
    case 'restart':
      await serviceRestart()
      return
    case 'logs':
      await serviceLogs(opts)
      return
    default: {
      emit('error', { code: 'unknown_subcommand', subcommand: `service ${sub}` })
      human(`${red('✗')} Unknown service subcommand: ${bold(sub)}`)
      console.log(SERVICE_USAGE)
      process.exit(ExitCode.Usage)
    }
  }
}

async function serviceInstall(opts: ServiceArgs): Promise<void> {
  const cliPath = resolveCliPath()
  if (!isAbsolute(cliPath) || !existsSync(cliPath)) {
    emit('error', { code: 'service_install_path_unresolved', cli_path: cliPath })
    human(`${red('✗')} Could not resolve the bridge CLI path (${dim(cliPath)}).`)
    process.exit(ExitCode.Runtime)
  }
  if (looksLikeNpxCachePath(cliPath)) {
    emit('error', {
      code: 'service_install_requires_global',
      cli_path: cliPath,
      hint: 'Run `npm install -g @sophonai/bridge` first; npx caches are pruned and the LaunchAgent would break silently.',
    })
    human('')
    human(`${red('✗')} Refusing to install a LaunchAgent pinned to an npx cache path:`)
    human(`    ${dim(cliPath)}`)
    human('')
    human(`  ${cyan('→')} Run ${bold('npm install -g @sophonai/bridge')} first, then re-run ${bold('bridge service install')}.`)
    process.exit(ExitCode.Runtime)
  }

  // No saved creds? Run the interactive pairing flow inline before
  // we hand the long-lived connection over to launchd. Service install
  // is the user's "do everything" command — pairing is part of that.
  if (!existsSync(credentialsLocation())) {
    human('')
    human(`${cyan('→')} Not paired yet — running interactive pairing first.`)
    human(dim(`  (a browser will open; claim "Pair this computer" on your iPhone)`))
    human('')
    const pairOk = await runPairingChildProcess(cliPath)
    if (!pairOk) {
      emit('error', {
        code: 'service_install_pairing_failed',
        credentials_file: credentialsLocation(),
        hint: 'Pairing didn\'t complete. Re-run, or run `bridge openclaw --pair-only` manually to debug.',
      })
      human('')
      human(`${red('✗')} Pairing didn't complete — aborting service install.`)
      process.exit(ExitCode.Runtime)
    }
    if (!existsSync(credentialsLocation())) {
      emit('error', {
        code: 'service_install_pairing_no_creds',
        credentials_file: credentialsLocation(),
      })
      human(`${red('✗')} Pairing exited cleanly but no credentials at ${dim(credentialsLocation())}.`)
      process.exit(ExitCode.Runtime)
    }
  }

  const existing = await gatherState()
  if (existing.loaded && !opts.force) {
    emit('service_install_noop', {
      result: 'already-installed',
      label: LAUNCH_AGENT_LABEL,
      plist_path: PLIST_PATH,
      pid: existing.pid ?? null,
    })
    human('')
    human(`${green('✓')} Bridge LaunchAgent already loaded (${dim(serviceTarget())}).`)
    human(`  ${cyan('→')} Reinstall with ${bold('bridge service install --force')}.`)
    return
  }

  const programArguments = [process.execPath, cliPath, 'openclaw', '--json']
  const environment = buildEnvironment()

  human('')
  human(`${brand('@sophonai/bridge service install')}`)
  human(`  ${dim('label:   ')} ${LAUNCH_AGENT_LABEL}`)
  human(`  ${dim('plist:   ')} ${PLIST_PATH}`)
  human(`  ${dim('exec:    ')} ${process.execPath}`)
  human(`  ${dim('cli:     ')} ${cliPath}`)
  human(`  ${dim('logs:    ')} ${STDOUT_LOG}`)
  human(`  ${dim('         ')} ${STDERR_LOG}`)
  human('')

  await bootoutSilent()
  await plistWriteAndStage({ programArguments, environment })
  try {
    await bootstrap()
  } catch (err) {
    emit('error', { code: 'service_bootstrap_failed', message: (err as Error).message })
    human(`${red('✗')} ${(err as Error).message}`)
    process.exit(ExitCode.Runtime)
  }
  try {
    await kickstart()
  } catch (err) {
    // Non-fatal: bootstrap already loads RunAtLoad agents. We log and
    // continue rather than rolling back, mirroring openclaw's choice.
    human(`${yellow('!')} ${(err as Error).message} ${dim('(non-fatal — bootstrap already loaded the agent)')}`)
  }

  const after = await gatherState()
  emit('service_installed', {
    label: LAUNCH_AGENT_LABEL,
    plist_path: PLIST_PATH,
    stdout_path: after.stdoutPath,
    stderr_path: after.stderrPath,
    loaded: after.loaded,
    pid: after.pid ?? null,
  })
  human(`${green('✓')} bridge installed under launchd ${dim(`(${serviceTarget()})`)}`)
  if (after.pid) human(`  ${dim('pid:')} ${after.pid}`)
  human(`  ${dim('logs:')} ${dim('tail -F')} ${after.stdoutPath}`)
  human(`  ${dim('check:')} ${bold('bridge service status')}`)
}

async function serviceUninstall(): Promise<void> {
  const before = await gatherState()
  if (!before.installed && !before.loaded) {
    emit('service_uninstall_noop', { plist_path: PLIST_PATH })
    human(`${dim('·')} no LaunchAgent at ${dim(PLIST_PATH)} — nothing to do`)
    return
  }
  await execLaunchctl(['bootout', guiDomain(), PLIST_PATH])
  await execLaunchctl(['bootout', serviceTarget()])
  let movedTo: string | null = null
  if (before.installed) {
    movedTo = await moveToTrash(PLIST_PATH)
  }
  emit('service_uninstalled', {
    plist_path: PLIST_PATH,
    moved_to_trash: movedTo,
  })
  human(`${green('✓')} bridge LaunchAgent uninstalled`)
  if (movedTo) human(`  ${dim('plist moved to:')} ${movedTo}`)
}

async function serviceStatus(): Promise<void> {
  const s = await gatherState()
  emit('service_status', {
    installed: s.installed,
    loaded: s.loaded,
    running: s.running,
    pid: s.pid ?? null,
    state: s.state ?? null,
    last_exit_code: s.lastExitCode ?? null,
    last_exit_reason: s.lastExitReason ?? null,
    plist_path: s.plistPath,
    stdout_path: s.stdoutPath,
    stderr_path: s.stderrPath,
    detail: s.detail ?? null,
  })
  if (isJsonMode()) return

  human('')
  human(`${brand('@sophonai/bridge service status')}`)
  human('')
  const kv = (k: string, v: string) => human(`  ${dim(k.padEnd(14))} ${v}`)
  kv('label', LAUNCH_AGENT_LABEL)
  kv('plist', s.installed ? green(s.plistPath) : `${red('missing')} ${dim(s.plistPath)}`)
  kv('loaded', s.loaded ? green('yes') : red('no'))
  kv('running', s.running ? green('yes') : (s.loaded ? yellow('no') : dim('—')))
  if (s.pid) kv('pid', String(s.pid))
  if (s.state) kv('state', s.state)
  if (typeof s.lastExitCode === 'number') {
    const c = s.lastExitCode === 0 ? green : red
    kv('last exit', c(String(s.lastExitCode)) + (s.lastExitReason ? ` ${dim(`(${s.lastExitReason})`)}` : ''))
  }
  kv('stdout', dim(s.stdoutPath))
  kv('stderr', dim(s.stderrPath))
  human('')
  if (!s.installed) {
    human(`  ${cyan('→')} install with ${bold('bridge service install')}`)
  } else if (!s.running) {
    human(`  ${cyan('→')} start with ${bold('bridge service restart')}`)
  } else {
    human(`  ${cyan('→')} live logs: ${bold(`bridge service logs -f`)}`)
  }
}

async function serviceRestart(): Promise<void> {
  const before = await gatherState()
  if (!before.installed) {
    emit('error', { code: 'service_not_installed', plist_path: PLIST_PATH })
    human(`${red('✗')} not installed — run ${bold('bridge service install')} first`)
    process.exit(ExitCode.Runtime)
  }
  if (!before.loaded) {
    // Plist exists but isn't loaded — bootstrap it first, then kickstart.
    try {
      await bootstrap()
    } catch (err) {
      emit('error', { code: 'service_bootstrap_failed', message: (err as Error).message })
      human(`${red('✗')} ${(err as Error).message}`)
      process.exit(ExitCode.Runtime)
    }
  }
  try {
    await kickstart()
  } catch (err) {
    emit('error', { code: 'service_kickstart_failed', message: (err as Error).message })
    human(`${red('✗')} ${(err as Error).message}`)
    process.exit(ExitCode.Runtime)
  }
  const after = await gatherState()
  emit('service_restarted', {
    pid: after.pid ?? null,
    state: after.state ?? null,
  })
  human(`${green('✓')} restarted ${dim(serviceTarget())}${after.pid ? ` ${dim(`(pid ${after.pid})`)}` : ''}`)
}

async function serviceLogs(opts: ServiceArgs): Promise<void> {
  const s = await gatherState()
  if (!opts.follow) {
    emit('service_logs', {
      stdout_path: s.stdoutPath,
      stderr_path: s.stderrPath,
      stdout_size: await sizeOrNull(s.stdoutPath),
      stderr_size: await sizeOrNull(s.stderrPath),
    })
    human('')
    human(`${brand('@sophonai/bridge service logs')}`)
    human('')
    human(`  ${dim('stdout:')} ${s.stdoutPath}`)
    human(`  ${dim('stderr:')} ${s.stderrPath}`)
    human('')
    human(`  ${cyan('→')} live tail: ${bold('bridge service logs -f')}`)
    human(`  ${cyan('→')} last ${opts.lines}: ${bold(`tail -n ${opts.lines} ${s.stdoutPath}`)}`)
    return
  }
  // Follow mode — exec tail -F so the user sees live output. We don't
  // re-implement tail because macOS ships it and it handles file
  // truncation/rotation correctly; we'd just reinvent buffering.
  human(`${dim('→ tail -F')} ${s.stdoutPath} ${dim('(Ctrl-C to stop)')}`)
  const child = spawn('tail', ['-F', '-n', String(opts.lines), s.stdoutPath, s.stderrPath], {
    stdio: 'inherit',
  })
  await new Promise<void>((resolve) => {
    const onSignal = () => child.kill('SIGTERM')
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    child.on('close', () => resolve())
  })
}

async function sizeOrNull(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return null
  }
}

/**
 * Spawn `bridge openclaw --pair-only` as a child with inherited stdio
 * so the user sees prompts (install openclaw? Y/n) and the browser
 * dance. Returns true if the child exits 0 — i.e. credentials are now
 * saved on disk. We don't try to parse pairing events from the child;
 * existsSync(credentialsLocation()) after exit is the source of truth.
 *
 * Inheriting stdio means the child's human() prints land in the same
 * terminal the user is staring at. JSON mode is intentionally NOT
 * forwarded — if we're driving pairing from `service install`, the
 * caller wanted a TTY flow.
 */
async function runPairingChildProcess(cliPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'openclaw', '--pair-only'], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
