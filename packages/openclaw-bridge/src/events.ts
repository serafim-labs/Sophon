/**
 * Tiny event bus for the CLI. Two output modes:
 *
 *   default  — human-friendly stderr via human(). Each emit() is a no-op
 *              so we don't double-print.
 *   --json   — NDJSON events on stdout, one JSON object per line:
 *              { "event": "ready", "ts": "…", … }. human() lines are
 *              suppressed so an agent's stdout stays parseable.
 *
 * This is a process-singleton because the CLI is exactly that — one
 * process. setJsonMode() is called once from main() before any other
 * code runs. No dependency injection needed.
 */

let jsonMode = false

export function setJsonMode(on: boolean): void {
  jsonMode = on
}

export function isJsonMode(): boolean {
  return jsonMode
}

/**
 * Documented event names. Keep in sync with README so agents can rely
 * on a stable contract.
 */
export type EventName =
  | 'starting'
  | 'openclaw_install_required'
  | 'openclaw_install_done'
  | 'openclaw_token_resolved'
  | 'pairing_started'
  | 'pairing_browser_opened'
  | 'pairing_waiting'
  | 'pairing_claimed'
  | 'pairing_e2e_sas'
  | 'pairing_expired'
  | 'pairing_timeout'
  | 'openclaw_connected'
  | 'sophon_connected'
  | 'ready'
  | 'shutdown'
  | 'error'
  | 'doctor_check'
  | 'doctor_summary'
  | 'status'

export function emit(event: EventName, payload: Record<string, unknown> = {}): void {
  if (!jsonMode) return
  const line = JSON.stringify({ event, ts: new Date().toISOString(), ...payload })
  process.stdout.write(line + '\n')
}

/**
 * Print a human-facing line to stderr. Suppressed in --json mode so the
 * caller can rely on stderr being silent except for fatal panics.
 */
export function human(line: string): void {
  if (jsonMode) return
  process.stderr.write(line + '\n')
}

/**
 * Always-on stderr line (errors, panics). Use sparingly — only for
 * things an agent should notice even in JSON mode (where they'd
 * normally also receive an `error` event with structured fields).
 */
export function alwaysStderr(line: string): void {
  process.stderr.write(line + '\n')
}
