/**
 * SAS emoji vocabulary — bridge side. Mirror of
 * `Sources/Crypto/SASEmojis.swift` on iOS. The two arrays MUST be
 * byte-for-byte identical or paired devices will display different
 * emojis and the user-verification step is broken.
 *
 * Why 32 entries: each SAS byte (we have 4 of them per pairing) maps
 * to `byte % 32` — 5 bits of entropy per emoji. Across 4 emojis that's
 * 20 bits = ~1M outcomes. A real-time MitM has ~one-in-a-million
 * chance of producing matching SAS on both sides; with retry attempts
 * users would notice.
 *
 * Why these 32: visually distinct, well-rendered across SF Pro on
 * iOS / iTerm / kitty / Apple Terminal / VS Code on macOS, no skin-
 * tone variants (avoid rendering drift), no ZWJ sequences (avoid
 * width inconsistency), no flag emojis (politically charged in some
 * locales). Categories balanced: animals, food, nature, objects.
 */
export const SAS_EMOJIS = [
  '🐱', '🐶', '🐭', '🐹', // 0..3
  '🐰', '🐻', '🐼', '🐨', // 4..7
  '🐯', '🦁', '🐮', '🐷', // 8..11
  '🐸', '🦊', '🐔', '🐺', // 12..15
  '🍎', '🍌', '🍇', '🍓', // 16..19
  '🍑', '🍒', '🥕', '🌽', // 20..23
  '🌙', '⭐', '🌈', '🔥', // 24..27
  '⚡', '🚀', '⚓', '🎁', // 28..31
] as const

if (SAS_EMOJIS.length !== 32) {
  throw new Error(`SAS_EMOJIS must be 32 entries (got ${SAS_EMOJIS.length})`)
}

/** Maps the 4-byte SAS into 4 emojis. Both sides display the same
 *  string; user confirms visual match across devices. */
export function sasToEmojis(sas: Uint8Array): string {
  if (sas.length !== 4) {
    throw new Error(`SAS must be 4 bytes (got ${sas.length})`)
  }
  return Array.from(sas, (b) => SAS_EMOJIS[b % 32]).join(' ')
}
