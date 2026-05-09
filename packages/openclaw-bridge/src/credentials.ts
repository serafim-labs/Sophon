import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface SavedCredentials {
  botToken: string
  installationId?: string
  sophonBase?: string
  /**
   * E2E install key as 64-char hex (32 raw bytes). Set when the
   * bridge paired via the new ECDH-based handshake (>= 0.7.0). When
   * absent we run in legacy plaintext-mode and the server stores
   * everything in cleartext — same as old bridges before this change.
   * See docs/ENCRYPTION_PLAN.md §5.
   */
  installKeyHex?: string
  savedAt: string
}

function configDir(): string {
  return process.env.SOPHON_CONFIG_DIR ?? join(homedir(), '.config', 'sophon')
}

function credentialsPath(): string {
  return join(configDir(), 'credentials.json')
}

export async function loadCredentials(sophonBase: string): Promise<SavedCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SavedCredentials>
    if (!parsed.botToken) return null
    if (parsed.sophonBase && parsed.sophonBase !== sophonBase) return null
    return parsed as SavedCredentials
  } catch {
    return null
  }
}

export async function saveCredentials(input: {
  botToken: string
  installationId?: string
  sophonBase: string
  installKeyHex?: string
}): Promise<void> {
  const path = credentialsPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    JSON.stringify(
      {
        botToken: input.botToken,
        installationId: input.installationId,
        sophonBase: input.sophonBase,
        ...(input.installKeyHex ? { installKeyHex: input.installKeyHex } : {}),
        savedAt: new Date().toISOString(),
      } satisfies SavedCredentials,
      null,
      2,
    ),
    { mode: 0o600 },
  )
  await chmod(path, 0o600).catch(() => {})
}

export async function clearCredentials(): Promise<void> {
  await rm(credentialsPath(), { force: true }).catch(() => {})
}

export function credentialsLocation(): string {
  return credentialsPath()
}
