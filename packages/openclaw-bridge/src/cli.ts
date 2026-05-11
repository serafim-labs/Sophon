#!/usr/bin/env node
/**
 * `npx @sophonai/bridge` entrypoint.
 *
 * Subcommand dispatcher:
 *
 *   npx @sophonai/bridge openclaw            ← bridge to local OpenClaw
 *   npx @sophonai/bridge doctor [connector]  ← preflight checklist
 *   npx @sophonai/bridge <connector>         ← future: claude-code, hermes, …
 *
 * Each connector lives in src/connectors/<id>.ts and exports a
 * ConnectorRunner. Common primitives (pairing, SAP WS client, credential
 * storage) are shared via src/sophon.ts, src/pair.ts, src/credentials.ts.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openclawConnector } from './connectors/openclaw.js'
import { ExitCode } from './exit-codes.js'
import { setJsonMode, isJsonMode, emit, human, alwaysStderr } from './events.js'
import { runService } from './service.js'
import { bold, brand, cyan, dim, green, red } from './style.js'
import type { ConnectorRunner } from './connectors/types.js'

const CONNECTORS: Record<string, ConnectorRunner> = {
  [openclawConnector.id]: openclawConnector,
}

const PKG_NAME = '@sophonai/bridge'
const DEFAULT_CONNECTOR = openclawConnector.id

function printRootHelp(): void {
  const list = Object.values(CONNECTORS)
    .map((c) => `  ${bold(c.id.padEnd(14))} ${green('✓')}  ${c.summary}`)
    .join('\n')
  // Static placeholders for connectors we'll ship later — agents reading
  // --help should know the surface they'll get without trawling the README.
  const planned = [
    `  ${dim('claude-code'.padEnd(14))} ${dim('·')}  ${dim('(planned) Anthropic Claude Code CLI')}`,
    `  ${dim('hermes'.padEnd(14))} ${dim('·')}  ${dim('(planned) Hermes self-hosted agents')}`,
  ].join('\n')
  // help goes to stdout via console.log so `cmd --help | less` works;
  // we still want the brand line styled when stdout is a TTY.
  console.log(`
${brand(PKG_NAME)} ${dim('— connect local agents to Sophon')}

${bold('Usage:')}
  npx ${PKG_NAME} <connector> [flags]
  npx ${PKG_NAME} service <command>    ${dim('# install/uninstall/status/restart/logs (macOS launchd)')}
  npx ${PKG_NAME} doctor [connector]   ${dim('# preflight checklist')}
  npx ${PKG_NAME} status               ${dim('# show saved credentials + paths')}
  npx ${PKG_NAME} --version

${bold('Connectors:')}
${list}
${planned}

Run \`npx ${PKG_NAME} <connector> --help\` for connector-specific flags.

${bold('Global flags:')}
  ${cyan('--json')}          Emit NDJSON events on stdout (suppresses human stderr).
                  Stable contract for agents — see README "JSON events".
  ${cyan('--verbose, -v')}   Log every wire event to stderr.

${bold('Exit codes:')}
  ${dim('0   ok            10  openclaw not installed     20  sophon unreachable')}
  ${dim('1   runtime       11  openclaw not initialized   21  pairing timeout')}
  ${dim('2   bad usage     12  openclaw unreachable       22  pairing expired')}
  ${dim('                  13  no openclaw token')}

${bold('Examples:')}
  npx ${PKG_NAME} openclaw                ${dim('# zero-config bridge to local OpenClaw')}
  npx ${PKG_NAME} service install         ${dim('# run the bridge under launchd — terminal can close')}
  npx ${PKG_NAME} service status          ${dim('# loaded? running? last exit?')}
  npx ${PKG_NAME} doctor                  ${dim('# check the openclaw setup')}
  npx ${PKG_NAME} openclaw --json --yes   ${dim('# agent-mode: NDJSON, no prompts')}
  npx ${PKG_NAME} openclaw --manual-pair  ${dim('# SSH/headless: print a 7-letter code')}
  npx ${PKG_NAME} openclaw --logout       ${dim('# forget saved Sophon credentials')}
`.trim())
}

function suggestSubcommand(input: string): string | null {
  const known = [...Object.keys(CONNECTORS), 'doctor', 'status', 'service', 'help']
  let best: { name: string; dist: number } | null = null
  for (const k of known) {
    const d = levenshtein(input, k)
    if (d <= 2 && (!best || d < best.dist)) best = { name: k, dist: d }
  }
  return best?.name ?? null
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const m = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) m[i]![0] = i
  for (let j = 0; j <= b.length; j++) m[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      m[i]![j] = Math.min(m[i - 1]![j]! + 1, m[i]![j - 1]! + 1, m[i - 1]![j - 1]! + cost)
    }
  }
  return m[a.length]![b.length]!
}

async function printVersion(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  let version = 'unknown'
  try {
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
    version = pkg.version ?? 'unknown'
  } catch {}
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify({ event: 'version', version }) + '\n')
  } else {
    console.log(version)
  }
}

async function printStatus(): Promise<void> {
  // Lightweight introspection — no network calls. Lets agents and humans
  // ask "what does the bridge think it knows?" without committing to a
  // long-running process.
  const { credentialsLocation, loadCredentials } = await import('./credentials.js')
  const sophonBase = process.env.SOPHON_BASE_URL ?? 'https://api.sophon.at'
  const saved = await loadCredentials(sophonBase)

  emit('status', {
    credentials_file: credentialsLocation(),
    sophon_base: sophonBase,
    paired: Boolean(saved?.botToken),
    installation_id: saved?.installationId ?? null,
    paired_at: saved?.savedAt ?? null,
  })
  if (isJsonMode()) return

  human('')
  human(brand(`${PKG_NAME} status`))
  human('')
  const kv = (k: string, v: string) => human(`  ${dim(k.padEnd(18))} ${v}`)
  kv('credentials file', dim(credentialsLocation()))
  kv('sophon base', dim(sophonBase))
  if (saved?.botToken) {
    kv('paired', green('yes'))
    kv('installation', bold(saved.installationId ?? 'unknown'))
    if (saved.savedAt) kv('paired at', dim(saved.savedAt))
  } else {
    kv('paired', `${red('no')} ${dim(`— run \`npx ${PKG_NAME} openclaw\` to pair`)}`)
  }
  human('')
}

function stripGlobalFlags(argv: string[]): string[] {
  // We strip --json / -j here because every connector and helper would
  // otherwise have to opt into ignoring it. --verbose stays in argv
  // because the connector wants to know whether to be chatty.
  return argv.filter((a) => a !== '--json' && a !== '-j')
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2)

  // Parse globals first so --json works on every subcommand.
  const json = rawArgv.includes('--json') || rawArgv.includes('-j') || process.env.SOPHON_JSON === '1'
  setJsonMode(json)
  const argv = stripGlobalFlags(rawArgv)

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    if (isJsonMode()) {
      // Agents asking for help in JSON mode get a structured manifest
      // instead of a wall of text — easier to feature-detect against.
      process.stdout.write(JSON.stringify({
        event: 'help',
        package: PKG_NAME,
        connectors: Object.values(CONNECTORS).map((c) => ({
          id: c.id,
          display_name: c.displayName,
          summary: c.summary,
          has_doctor: Boolean(c.doctor),
        })),
        global_subcommands: ['doctor', 'status', 'service', '--version', '--help'],
        global_flags: ['--json', '--verbose'],
      }) + '\n')
    } else {
      printRootHelp()
    }
    process.exit(ExitCode.Ok)
  }

  if (argv[0] === '--version' || argv[0] === '-V') {
    await printVersion()
    process.exit(ExitCode.Ok)
  }

  if (argv[0] === 'status') {
    await printStatus()
    process.exit(ExitCode.Ok)
  }

  if (argv[0] === 'service') {
    await runService(argv.slice(1))
    process.exit(ExitCode.Ok)
  }

  if (argv[0] === 'doctor') {
    // `doctor [connector]` — defaults to the only shipped one.
    const sub = argv[1] && !argv[1].startsWith('-') ? argv[1] : DEFAULT_CONNECTOR
    const connector = CONNECTORS[sub]
    if (!connector || !connector.doctor) {
      emit('error', { code: 'no_doctor', connector: sub })
      alwaysStderr(`No doctor available for connector: ${sub}`)
      process.exit(ExitCode.Usage)
    }
    const rest = argv[1] === sub ? argv.slice(2) : argv.slice(1)
    const verbose = rest.includes('--verbose') || rest.includes('-v') || process.env.VERBOSE === '1'
    const report = await connector.doctor({ argv: rest, verbose })
    process.exit(report.ok ? ExitCode.Ok : ExitCode.Runtime)
  }

  const sub = argv[0]!
  const connector = CONNECTORS[sub]
  if (!connector) {
    const guess = suggestSubcommand(sub)
    emit('error', { code: 'unknown_subcommand', subcommand: sub, suggestion: guess })
    alwaysStderr(`${red('✗')} Unknown subcommand: ${bold(sub)}`)
    if (guess) alwaysStderr(`  ${dim('→ Did you mean')} ${cyan(guess)}${dim('?')}`)
    if (!isJsonMode()) {
      alwaysStderr('')
      printRootHelp()
    }
    process.exit(ExitCode.Usage)
  }

  const rest = argv.slice(1)
  const verbose = rest.includes('--verbose') || rest.includes('-v') || process.env.VERBOSE === '1'
  await connector.run({ argv: rest, verbose })
}

main().catch((err) => {
  const e = err as Error
  emit('error', { code: 'fatal', message: e.message ?? String(err) })
  alwaysStderr(`${red('✗ fatal:')} ${e.message ?? err}`)
  if (process.env.VERBOSE === '1' && e.stack) alwaysStderr(dim(e.stack))
  process.exit(ExitCode.Runtime)
})
