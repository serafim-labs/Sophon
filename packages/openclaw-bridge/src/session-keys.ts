/**
 * Per-session symmetric `session_key` store for the bridge — counterpart
 * of iOS's per-session Keychain entries. Lives on disk under
 *   `~/.config/sophon/session-keys.json`
 * (same dir as `credentials.json`, 0o600).
 *
 * One 32-byte key per chat session id. Keys are generated locally either
 * by the bridge (when the bridge starts the session) or unwrapped from a
 * sealed-box envelope delivered by an iOS sibling that knew us as a
 * recipient (the `session_key_granted` flow).
 *
 * Persistence is best-effort write-through: every mutation rewrites the
 * full file. The store is small (one entry per chat session, 32 bytes
 * each) so this is fine — writes are dwarfed by the actual messaging
 * traffic. Reads happen during routine encrypt/decrypt; we keep the map
 * in memory and only touch disk at startup + on writes.
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'

const KEY_BYTES = 32

function configDir(): string {
  return process.env.SOPHON_CONFIG_DIR ?? join(homedir(), '.config', 'sophon')
}

function storePath(): string {
  return join(configDir(), 'session-keys.json')
}

interface OnDiskShape {
  /** session_id → 64-char hex of the 32-byte session_key. */
  keys: Record<string, string>
  savedAt: string
}

export class SessionKeyStore {
  private inMemory: Map<string, Uint8Array> = new Map()
  private loaded = false

  /** Load from disk if it exists. Idempotent — calling twice is a no-op
   *  after the first load. Safe to call before any get/set call. */
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(storePath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<OnDiskShape>
      if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') {
        for (const [sid, hex] of Object.entries(parsed.keys)) {
          if (typeof hex !== 'string') continue
          if (hex.length !== KEY_BYTES * 2) continue
          if (!/^[0-9a-f]+$/.test(hex)) continue
          this.inMemory.set(sid, new Uint8Array(Buffer.from(hex, 'hex')))
        }
      }
    } catch {
      // Missing / unreadable file — start with an empty store.
    }
    this.loaded = true
  }

  /** Read the session_key for `sessionId`, or `null` if unknown. */
  get(sessionId: string): Uint8Array | null {
    return this.inMemory.get(sessionId) ?? null
  }

  /** Atomically read OR generate a fresh 32-byte session_key for the
   *  given session. Used when the BRIDGE creates a session (no
   *  pre-existing key) and needs one immediately for outbound encryption.
   *  After this call you should fan out wrappers to every authorized
   *  recipient via POST /v1/bridge/sessions/:id/recipients. */
  async getOrCreate(sessionId: string): Promise<Uint8Array> {
    const existing = this.inMemory.get(sessionId)
    if (existing) return existing
    const fresh = new Uint8Array(randomBytes(KEY_BYTES))
    this.inMemory.set(sessionId, fresh)
    await this.flush()
    return fresh
  }

  /** Store a session_key delivered by an external grant (iOS sibling
   *  wrapped the key for us under our device pubkey, server forwarded
   *  it; we unwrapped via `sealedBoxDecrypt`). Idempotent if the same
   *  bytes were already cached. Throws on length mismatch. */
  async set(sessionId: string, key: Uint8Array): Promise<void> {
    if (key.length !== KEY_BYTES) {
      throw new Error(`SessionKeyStore.set: bad key length ${key.length}`)
    }
    const existing = this.inMemory.get(sessionId)
    if (existing && Buffer.from(existing).equals(Buffer.from(key))) return
    this.inMemory.set(sessionId, new Uint8Array(key))
    await this.flush()
  }

  /** All currently-known (sessionId, key) pairs. Used by the device-
   *  joined fan-out: when a sibling device shows up, the bridge wraps
   *  every session_key we know about and posts grants. */
  entries(): Array<[string, Uint8Array]> {
    return Array.from(this.inMemory.entries())
  }

  /** Drop the in-memory + on-disk entry for a session. Called on
   *  session deletion. Best-effort. */
  async forget(sessionId: string): Promise<void> {
    if (!this.inMemory.delete(sessionId)) return
    await this.flush()
  }

  private async flush(): Promise<void> {
    const path = storePath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const out: OnDiskShape = {
      keys: Object.fromEntries(
        Array.from(this.inMemory.entries()).map(([sid, key]) => [
          sid,
          Buffer.from(key).toString('hex'),
        ]),
      ),
      savedAt: new Date().toISOString(),
    }
    await writeFile(path, JSON.stringify(out, null, 2), { mode: 0o600 })
    await chmod(path, 0o600).catch(() => {})
  }
}
