/**
 * Sophon e2e crypto primitives — bridge side.
 *
 * Implements the wire format & key derivation specified in
 * docs/ENCRYPTION_PLAN.md §4 + §6 — versioned AES-GCM AEAD, HKDF-SHA256
 * key derivation, HMAC-SHA256 blind indexes, X25519 ECDH for pairing.
 *
 * **Threat model boundary (recap)**: this code runs on the user's Mac
 * alongside OpenClaw / Claude Code, both of which already write
 * plaintext logs locally. Hardening key storage further than 0600 file
 * perms would be theater. Goal is "Sophon's servers see only ciphertext."
 *
 * Counterpart on iOS: `Sources/Crypto/SophonCrypto.swift` (CryptoKit).
 * Wire formats MUST stay byte-compatible between the two — see
 * §6 of the plan, and the cross-platform test vectors that pin each
 * format down.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { Buffer } from 'node:buffer'
import nacl from 'tweetnacl'

// ─── Wire format constants (plan §6) ────────────────────────────────

/** Symmetric AEAD format version. Bump when the layout changes. */
export const SYMM_VERSION_V1 = 0x01

/** Sealed-box (anonymous-recipient ECIES) format version.
 *  Layout:  [0x02] [ephemeral_pubkey 32] [inner symmetric envelope]
 *  See `sealedBoxEncrypt` for the construction. */
export const SEALED_BOX_VERSION_V1 = 0x02

/** Reserved sentinel — encrypted-empty (encoded plaintext was zero
 *  length). Single byte, distinguishable from any valid v1 envelope
 *  because v1 starts with version byte 0x01. Lets callers tell apart
 *  "ciphertext encoding empty plaintext" from "missing/null column". */
export const NULL_SENTINEL = 0x00

/** AES-256-GCM nonce length — the GCM standard, hardware-accelerated. */
export const AES_GCM_NONCE_BYTES = 12
/** GCM authentication tag size. */
export const AES_GCM_TAG_BYTES = 16
/** AES-256 key size. */
export const AES_KEY_BYTES = 32
/** HMAC-SHA256 output / blind-index full size. We truncate to 16 for
 *  storage to keep the index column compact while retaining 128-bit
 *  collision resistance. */
export const BLIND_INDEX_BYTES = 16
/** X25519 private/public key size. */
export const X25519_KEY_BYTES = 32

// ─── Errors ─────────────────────────────────────────────────────────

/** Thrown when a ciphertext envelope's version byte isn't recognised. */
export class UnsupportedVersionError extends Error {
  constructor(public readonly version: number) {
    super(`unsupported ciphertext version: 0x${version.toString(16)}`)
    this.name = 'UnsupportedVersionError'
  }
}

/** Thrown for malformed envelopes (too short, truncated, etc). */
export class MalformedEnvelopeError extends Error {
  constructor(message: string) {
    super(`malformed ciphertext envelope: ${message}`)
    this.name = 'MalformedEnvelopeError'
  }
}

// ─── Symmetric AEAD (plan §6.1) ────────────────────────────────────
//
// Wire format (29 byte overhead total):
//   [version 0x01] [nonce 12 B] [ciphertext N B] [tag 16 B]
//
// `encryptSymmetric` produces a fresh random nonce per call — never
// derive a deterministic nonce from key+plaintext, that breaks GCM's
// security. Use `blindIndex` (step 1.3) for deterministic lookup keys.
//
// `decryptSymmetric` returns `null` rather than throwing on AEAD
// failure to avoid timing oracles — callers cannot distinguish "wrong
// key", "tampered ciphertext", or "wrong format version" from the
// duration of the call. The thrown errors (UnsupportedVersionError,
// MalformedEnvelopeError) only fire on structural problems that any
// observer with a valid envelope could trip themselves.

/** Encrypts `plaintext` under `key` using AES-256-GCM. Returns the
 *  full envelope ready for storage on the wire. */
export function encryptSymmetric(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`bad key length: expected ${AES_KEY_BYTES}, got ${key.length}`)
  }
  // Empty plaintext gets the 1-byte NULL_SENTINEL so callers can
  // distinguish "encrypted empty value" from "no value persisted at
  // all". A 0-length payload would round-trip safely through GCM but
  // the calling code paths (DB columns) need a way to tell those
  // states apart on read.
  if (plaintext.length === 0) {
    return new Uint8Array([NULL_SENTINEL])
  }
  const nonce = randomBytes(AES_GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  const envelope = new Uint8Array(1 + AES_GCM_NONCE_BYTES + body.length + AES_GCM_TAG_BYTES)
  envelope[0] = SYMM_VERSION_V1
  envelope.set(nonce, 1)
  envelope.set(body, 1 + AES_GCM_NONCE_BYTES)
  envelope.set(tag, 1 + AES_GCM_NONCE_BYTES + body.length)
  return envelope
}

/** Decrypts an envelope produced by `encryptSymmetric`. Returns the
 *  plaintext, or `null` on AEAD failure (wrong key / tampered bytes).
 *  Throws on structural problems (truncation, unknown version). */
export function decryptSymmetric(envelope: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`bad key length: expected ${AES_KEY_BYTES}, got ${key.length}`)
  }
  if (envelope.length === 0) {
    throw new MalformedEnvelopeError('empty buffer')
  }

  // NULL_SENTINEL: caller asked us to round-trip an empty plaintext.
  // No key check needed — there's no key material in a sentinel.
  if (envelope.length === 1 && envelope[0] === NULL_SENTINEL) {
    return new Uint8Array(0)
  }

  const version = envelope[0] ?? -1 // length >= 1 above guarantees [0] is set
  if (version !== SYMM_VERSION_V1) {
    throw new UnsupportedVersionError(version)
  }

  const minLength = 1 + AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES
  if (envelope.length < minLength) {
    throw new MalformedEnvelopeError(`length ${envelope.length} < min ${minLength}`)
  }

  const nonce = envelope.slice(1, 1 + AES_GCM_NONCE_BYTES)
  const tag = envelope.slice(envelope.length - AES_GCM_TAG_BYTES)
  const body = envelope.slice(1 + AES_GCM_NONCE_BYTES, envelope.length - AES_GCM_TAG_BYTES)

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()])
    return new Uint8Array(plaintext)
  } catch {
    // Generic AEAD failure — exact reason (bad key vs tampered) stays
    // hidden. Callers see `null` and decide.
    return null
  }
}

// ─── KDF + blind index (plan §4 + §6.3) ────────────────────────────
//
// Hierarchy (recap from plan §4):
//
//     install_key (32 B, root, lives on bridge + iOS only)
//        │
//        ├─ HKDF(install_key, "sophon/v1/blob/" + path) → AES-GCM key
//        │     One key per logical column / per record. The `path`
//        │     argument is application-defined; conventions in §4:
//        │       "messages/<id>"
//        │       "tasks/<id>/input"
//        │       "agent_files/<sid>/<blind_idx>"
//        │       "sessions/<sid>/title"   etc.
//        │
//        └─ HKDF(install_key, "sophon/v1/blind-index") → HMAC-SHA256 key
//              Used to compute deterministic 16-byte indexes that let
//              the server gate by-path lookups (e.g., /file proxy)
//              without learning the path.
//
// All HKDF use SHA-256 — matches Apple CryptoKit's default and node's
// hkdfSync default. SHA-512 would be fine too but we don't need 64-byte
// output anywhere.

/** Application-prefix for every KDF call. Bumping `v1` is the way we
 *  rotate ALL derived keys without touching install_key. Keep this
 *  string identical between iOS and bridge — it goes into the HKDF
 *  info field, mismatch ⇒ different keys ⇒ silent decryption failure. */
const KDF_PREFIX = 'sophon/v1'

/** Derives a 32-byte AES key from an install_key + a per-blob path.
 *  Different paths produce independent keys. Same path always
 *  produces the same key (deterministic). */
export function deriveBlobKey(installKey: Uint8Array, path: string): Uint8Array {
  if (installKey.length !== AES_KEY_BYTES) {
    throw new Error(`bad install_key length: expected ${AES_KEY_BYTES}, got ${installKey.length}`)
  }
  const info = Buffer.from(`${KDF_PREFIX}/blob/${path}`, 'utf8')
  // node's hkdfSync(digest, ikm, salt, info, length). Empty salt is
  // standard when the IKM is already a uniform random key (HKDF-Expand-only
  // semantics — see RFC 5869 §3.3 "Salt Optional").
  const out = hkdfSync('sha256', installKey, new Uint8Array(0), info, AES_KEY_BYTES)
  return new Uint8Array(out as ArrayBuffer)
}

/** Derives the blind-index HMAC key from an install_key. Stable for
 *  the lifetime of the install_key — caller can cache. */
export function deriveBlindIndexKey(installKey: Uint8Array): Uint8Array {
  if (installKey.length !== AES_KEY_BYTES) {
    throw new Error(`bad install_key length: expected ${AES_KEY_BYTES}, got ${installKey.length}`)
  }
  const info = Buffer.from(`${KDF_PREFIX}/blind-index`, 'utf8')
  const out = hkdfSync('sha256', installKey, new Uint8Array(0), info, AES_KEY_BYTES)
  return new Uint8Array(out as ArrayBuffer)
}

/** Computes a deterministic 16-byte (128-bit) lookup key from a key
 *  derived via `deriveBlindIndexKey` plus a scope + variadic inputs.
 *  Same inputs always produce the same output, enabling server-side
 *  matches without server learning what's being matched.
 *
 *  Inputs are joined with a 0xFF byte separator so adjacent strings
 *  can't be reordered to produce the same hash. (Length-prefix would
 *  also work; chose 0xFF for visual matchability of vectors and
 *  because none of our inputs contain raw 0xFF bytes — they're all
 *  utf-8 strings or hex-encoded ids.)
 *
 *  Encoded as base64url for storage in a varchar column (no padding,
 *  url-safe alphabet, 22 chars for 16 bytes). */
export function blindIndex(
  indexKey: Uint8Array,
  scope: string,
  ...inputs: string[]
): string {
  if (indexKey.length !== AES_KEY_BYTES) {
    throw new Error(`bad index_key length: expected ${AES_KEY_BYTES}, got ${indexKey.length}`)
  }
  const hmac = createHmac('sha256', indexKey)
  hmac.update(Buffer.from(scope, 'utf8'))
  for (const input of inputs) {
    hmac.update(new Uint8Array([0xff])) // separator
    hmac.update(Buffer.from(input, 'utf8'))
  }
  const full = hmac.digest()
  return full.subarray(0, BLIND_INDEX_BYTES).toString('base64url')
}

// ─── Pairing handshake (plan §5) ───────────────────────────────────
//
// X25519 ECDH between iOS and bridge. The protocol:
//
//   Bridge → server:  B_pub  = generateKeypair().publicKey
//   iOS    ← server:  fetch B_pub via pairing code
//   iOS:              I_kp = generateKeypair()
//                     install_key = deriveInstallKeyFromECDH(I_kp.secret, B_pub)
//                     sas         = deriveSASFromECDH(I_kp.secret, B_pub)
//                     POST I_kp.publicKey to server
//   Bridge:           fetch I_pub
//                     install_key = deriveInstallKeyFromECDH(B_kp.secret, I_pub)
//                     sas         = deriveSASFromECDH(B_kp.secret, I_pub)
//
// Both sides derive the same install_key + sas (ECDH commutativity).
// Both sides display the 4-byte sas as 4 emojis; user confirms emoji
// match across screens — defeats server-MitM during pairing, the one
// moment when our "server-blind" promise is actually at risk.
//
// We never expose the raw X25519 shared secret in the public API.
// See `deriveECDHKey` for the cross-platform compatibility note.

/** A Curve25519 keypair. `secretKey` MUST stay on the originating
 *  device; `publicKey` is published to the server via pairing. */
export type X25519KeyPair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/** Generates a fresh X25519 keypair for pairing. Keys are 32 bytes
 *  each. The secret key gets clamped per RFC 7748 by tweetnacl
 *  internally — caller doesn't need to do anything special. */
export function generateKeypair(): X25519KeyPair {
  // tweetnacl.box.keyPair() is what Happy uses too — well-audited
  // glue around the underlying `crypto_box_keypair` semantics.
  const kp = nacl.box.keyPair()
  return {
    publicKey: new Uint8Array(kp.publicKey),
    secretKey: new Uint8Array(kp.secretKey),
  }
}

/** Combined ECDH + HKDF derivation. Returns the install_key both
 *  sides will use for all subsequent symmetric encryption.
 *
 *  We deliberately don't expose the raw X25519 shared secret.
 *  Apple CryptoKit's `SharedSecret.withUnsafeBytes` returns an
 *  internal representation that differs from tweetnacl's
 *  `nacl.box.before` output, but the post-HKDF derived key matches
 *  byte-for-byte across both libs (verified by the cross-platform
 *  vector tests). Hiding the raw shared inside the function is the
 *  only way to keep the API portable across these two impls. */
export function deriveInstallKeyFromECDH(
  mySecret: Uint8Array,
  theirPublic: Uint8Array,
): Uint8Array {
  return deriveECDHKey(mySecret, theirPublic, `${KDF_PREFIX}/install_key`, AES_KEY_BYTES)
}

/** Derives a short authentication string for the pairing handshake.
 *  Returns 4 bytes (32 bits) — small enough to render as 4 emojis,
 *  strong enough to defeat real-time MitM. UI layer owns the emoji
 *  vocabulary; this function is byte-only. */
export function deriveSASFromECDH(
  mySecret: Uint8Array,
  theirPublic: Uint8Array,
): Uint8Array {
  return deriveECDHKey(mySecret, theirPublic, `${KDF_PREFIX}/sas`, 4)
}

/** Internal: combine X25519 + HKDF in one step. */
function deriveECDHKey(
  mySecret: Uint8Array,
  theirPublic: Uint8Array,
  info: string,
  length: number,
): Uint8Array {
  if (mySecret.length !== X25519_KEY_BYTES) {
    throw new Error(`bad secretKey length: expected ${X25519_KEY_BYTES}, got ${mySecret.length}`)
  }
  if (theirPublic.length !== X25519_KEY_BYTES) {
    throw new Error(`bad publicKey length: expected ${X25519_KEY_BYTES}, got ${theirPublic.length}`)
  }
  // tweetnacl's box.before is the pure scalar-mult X25519 output.
  const shared = nacl.box.before(theirPublic, mySecret)
  const out = hkdfSync('sha256', shared, new Uint8Array(0), Buffer.from(info, 'utf8'), length)
  return new Uint8Array(out as ArrayBuffer)
}

// ─── Sealed-box (anonymous-recipient ECIES) ─────────────────────────
//
// Encrypt a payload (typically a 32-byte session_key) for one recipient
// identified by their long-term X25519 pubkey. Sender doesn't need a
// long-term identity — a fresh ephemeral keypair is generated per call,
// the public half is bundled with the ciphertext, and the secret half
// is discarded. This gives forward secrecy on the wrap side: an
// attacker who later compromises a sender's long-term key gains
// nothing about already-wrapped session keys.
//
// Wire format (62-byte overhead):
//   [version 0x02] [eph_pub 32 B] [inner symmetric envelope (1+12+N+16)]
//
// The inner envelope is exactly what `encryptSymmetric` emits — same
// version byte 0x01 nested inside, AES-256-GCM body keyed by
//   shared = HKDF-SHA256(ECDH(eph_sec, recipient_pub),
//                        info = "sophon/v1/sealed-box")
//
// Recipient recovers `shared` from `ECDH(recipient_sec, eph_pub)` and
// the same HKDF info, then decrypts via `decryptSymmetric`. AEAD
// failure returns `null` (timing-uniform with bad-key / tamper).

const SEALED_BOX_KDF_INFO = `${KDF_PREFIX}/sealed-box`

/** Encrypt `plaintext` so that only the holder of the secret matching
 *  `recipientPublic` can decrypt. Generates a fresh ephemeral X25519
 *  keypair internally and zeroes the secret half after derivation. */
export function sealedBoxEncrypt(
  plaintext: Uint8Array,
  recipientPublic: Uint8Array,
): Uint8Array {
  if (recipientPublic.length !== X25519_KEY_BYTES) {
    throw new Error(
      `bad recipientPublic length: expected ${X25519_KEY_BYTES}, got ${recipientPublic.length}`,
    )
  }
  const eph = nacl.box.keyPair()
  const shared = nacl.box.before(recipientPublic, eph.secretKey)
  const sharedKey = hkdfSync(
    'sha256',
    shared,
    new Uint8Array(0),
    Buffer.from(SEALED_BOX_KDF_INFO, 'utf8'),
    AES_KEY_BYTES,
  )
  const inner = encryptSymmetric(plaintext, new Uint8Array(sharedKey as ArrayBuffer))
  // Best-effort wipe of the ephemeral secret + derived shared. Doesn't
  // help against a heap dump but limits the lifetime of the bytes in
  // long-running processes.
  eph.secretKey.fill(0)
  ;(shared as Uint8Array).fill(0)

  const envelope = new Uint8Array(1 + X25519_KEY_BYTES + inner.length)
  envelope[0] = SEALED_BOX_VERSION_V1
  envelope.set(eph.publicKey, 1)
  envelope.set(inner, 1 + X25519_KEY_BYTES)
  return envelope
}

/** Decrypt a `sealedBoxEncrypt` envelope addressed to a holder of
 *  `recipientSecret`. Returns the plaintext, or `null` on AEAD failure
 *  (wrong key / tampered bytes / wrong recipient). Throws on structural
 *  problems (truncation, unknown version). */
export function sealedBoxDecrypt(
  envelope: Uint8Array,
  recipientSecret: Uint8Array,
): Uint8Array | null {
  if (recipientSecret.length !== X25519_KEY_BYTES) {
    throw new Error(
      `bad recipientSecret length: expected ${X25519_KEY_BYTES}, got ${recipientSecret.length}`,
    )
  }
  if (envelope.length === 0) {
    throw new MalformedEnvelopeError('empty buffer')
  }
  const version = envelope[0]
  if (version !== SEALED_BOX_VERSION_V1) {
    throw new UnsupportedVersionError(version ?? -1)
  }
  const minLength = 1 + X25519_KEY_BYTES + 1 // outer header + at least the inner version byte
  if (envelope.length < minLength) {
    throw new MalformedEnvelopeError(`length ${envelope.length} < min ${minLength}`)
  }
  const ephPub = envelope.slice(1, 1 + X25519_KEY_BYTES)
  const inner = envelope.slice(1 + X25519_KEY_BYTES)

  const shared = nacl.box.before(ephPub, recipientSecret)
  const sharedKey = hkdfSync(
    'sha256',
    shared,
    new Uint8Array(0),
    Buffer.from(SEALED_BOX_KDF_INFO, 'utf8'),
    AES_KEY_BYTES,
  )
  ;(shared as Uint8Array).fill(0)

  return decryptSymmetric(inner, new Uint8Array(sharedKey as ArrayBuffer))
}
