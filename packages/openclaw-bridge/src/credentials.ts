import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface SavedCredentials {
  botToken: string
  installationId?: string
  sophonBase?: string
  /**
   * Long-term X25519 keypair that identifies this bridge as a `devices`
   * row on the server (platform='bridge'). The pubkey is registered
   * via POST /v1/bridge/devices on every WS connect; siblings encrypt
   * session_keys for us under this pubkey via sealed-box.
   *
   * Generated on first boot and persisted across restarts. Wiping
   * these forces all session_keys to be re-granted by sibling devices
   * (and the existing wrappers on the server become useless).
   *
   * Repurposed from the pre-0.12.0 install_key handshake where the
   * same keypair was used for ECDH-derived install_key. Migration
   * 0023 dropped install_key entirely; the bytes here now serve only
   * as long-term device identity.
   */
  bridgeSecretHex?: string
  bridgePubkeyHex?: string
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
  bridgeSecretHex?: string
  bridgePubkeyHex?: string
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
        ...(input.bridgeSecretHex ? { bridgeSecretHex: input.bridgeSecretHex } : {}),
        ...(input.bridgePubkeyHex ? { bridgePubkeyHex: input.bridgePubkeyHex } : {}),
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
