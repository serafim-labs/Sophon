export interface ConnectorContext {
  argv: string[]
  verbose: boolean
}

export interface ConnectorRunner {
  id: string
  displayName: string
  summary: string
  run: (ctx: ConnectorContext) => Promise<void>
  /**
   * Optional preflight checklist. Prints a checklist to stderr and
   * resolves with `ok: false` if any check failed. The dispatcher maps
   * `ok: false` to a non-zero exit code so agents can branch on it.
   */
  doctor?: (ctx: ConnectorContext) => Promise<{ ok: boolean }>
}
