/**
 * Exit codes the bridge CLI returns. Documented in README so callers
 * (humans and agents) can branch on specific failure modes.
 *
 * 0   — clean exit
 * 1   — runtime error
 * 2   — bad usage (unknown flag, unknown subcommand, bad args)
 * 10  — OpenClaw is not installed on this machine
 * 11  — OpenClaw installed but local gateway not initialized
 * 12  — OpenClaw gateway unreachable on the configured WS URL
 * 13  — Could not resolve an OpenClaw operator token
 * 20  — Sophon API unreachable on the configured base URL
 * 21  — Pairing window timed out (no claim within ~120s)
 * 22  — Pairing code expired before claim
 */
export const ExitCode = {
  Ok: 0,
  Runtime: 1,
  Usage: 2,
  OpenclawNotInstalled: 10,
  OpenclawNotInitialized: 11,
  OpenclawUnreachable: 12,
  OpenclawNoToken: 13,
  SophonUnreachable: 20,
  PairingTimeout: 21,
  PairingExpired: 22,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]
