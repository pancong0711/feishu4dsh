/**
 * Small dependency-free helpers shared by every module.
 * @module feishu4dsh/util
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Current epoch milliseconds; substitutable in tests. */
export const nowMs = (): number => Date.now()

/**
 * Await a fixed delay.
 * @param ms - milliseconds to sleep.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * Short content hash for stable, human-readable identifiers.
 * @param input - text to hash.
 * @param length - hex chars to keep.
 * @returns lowercase hex digest prefix.
 */
export function shortHash(input: string, length = 10): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length)
}

/**
 * Render an integer for chat surfaces using the current locale's grouping,
 * e.g. `12,345`. Non-finite/negative values fall back to `0`.
 * @param value - number to format.
 * @returns formatted number string.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('zh-CN')
}

/**
 * Render a byte count for chat surfaces, e.g. `3.2 MiB`.
 * @param bytes - size in bytes.
 * @returns human-readable size string.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/**
 * Sanitize an inbound file name for safe local storage: strip path
 * components, control characters, and leading dots; cap the length; fall
 * back to a generated name when nothing usable remains.
 * @param raw - file name reported by the platform (untrusted input).
 * @param fallback - name used when sanitization empties the string.
 * @returns a safe single path segment.
 */
export function sanitizeFileName(raw: string, fallback: string): string {
  const base = raw
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim() ?? ''
  const capped = base.slice(0, 120)
  if (capped === '') return fallback
  return capped
}

/**
 * Constant-time string comparison for signature/token checks.
 * @param a - first value.
 * @param b - second value.
 * @returns whether both strings are equal.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** `MM-DD HH:mm` of a date, local time — `/session` list rendering (R29). */
export function formatStamp(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Split a long markdown string into chunks no longer than `limit` characters.
 *
 * Ported from `@larksuiteoapi/node-sdk`'s `splitWithCodeFences` so the bridge
 * can chunk **before** handing text to the SDK. This matters because the SDK's
 * `sendMarkdown`/`sendText` only pass `replyTo` to the **first** chunk; every
 * later chunk goes through `message.create` and lands in the chat root instead
 * of the thread. Chunking ourselves, one chunk < the SDK's chunk limit, means
 * the SDK never splits again — so every chunk we send keeps its thread anchor
 * (R48). Keeping our own copy also avoids depending on an internal, unexported
 * SDK function.
 *
 * Guarantees (see `tests/util.spec.ts`):
 * - **no emitted chunk exceeds `limit`** — including a single over-long line
 *   with no newline to break on, which the SDK's own version leaves whole (and
 *   would then re-split, dropping the thread anchor again);
 * - code-fence integrity: a chunk that begins/ends inside a fenced block opens
 *   with a ` ```lang ` line and closes with ` ``` `, so every emitted chunk is
 *   self-contained. A standalone fence line is treated as structure (it flips
 *   the state), never as duplicated content;
 * - a heading line is preferred as a break point once the buffer is >75% full.
 *
 * @param text - markdown to split.
 * @param limit - maximum characters per chunk (must stay below the SDK's own
 *   `DEFAULT_CHUNK_LIMIT` of 3500 so the SDK never re-splits).
 * @returns one chunk when already short enough, otherwise an ordered list of
 *   chunks whose concatenation reconstructs the original text (modulo the
 *   inserted fence markers).
 */
export function splitWithCodeFences(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const CLOSE_MARKER = '```'
  const openMarker = (lang: string): string => '```' + lang
  /** Matches a standalone fence line, capturing its language tag. */
  const FENCE = /^```(\w*)$/

  const out: string[] = []
  let lines: string[] = [] // content lines (never fence markers)
  let startFence: string | null = null // fence state when this chunk began
  let fence: string | null = null // live fence state (before the next line)

  /**
   * The exact bytes of the chunk if flushed right now. `startFence` governs
   * the opening marker; the live `fence` governs the closing marker.
   */
  const render = (): string => {
    const head = startFence === null ? '' : openMarker(startFence) + '\n'
    const tail = fence === null ? '' : '\n' + CLOSE_MARKER
    return head + lines.join('\n') + tail
  }

  const flush = (): void => {
    if (lines.length > 0 || startFence !== null || fence !== null) out.push(render())
    lines = []
    startFence = fence
  }

  for (const raw of text.split('\n')) {
    const m = raw.match(FENCE)
    if (m) {
      // Structural line: it is a chunk boundary, not content. Flush what we
      // have (with the fence state as it stood for that content), then flip the
      // fence so the *next* chunk opens with the right marker.
      flush()
      fence = fence === null ? (m[1] ?? '') : null
      startFence = fence // the next chunk opens with this fence
      continue
    }

    const isHeading = /^#{1,6}\s/.test(raw)
    if (isHeading && lines.length > 0 && render().length > limit * 0.75) flush()

    if (raw.length === 0) {
      // A blank line is content; keep paragraph breaks.
      if (lines.length > 0 && render().length + 1 > limit) flush()
      lines.push('')
      continue
    }

    let rest = raw
    while (rest.length > 0) {
      const trial = lines.concat([rest])
      const prev = lines
      lines = trial
      if (render().length <= limit) break
      lines = prev

      if (lines.length > 0) {
        flush()
        continue
      }
      // Empty chunk and the piece still does not fit: hard-wrap it.
      const room = limit - render().length - 1 // +1 for the newline separator
      const take = room >= 1 ? room : 1
      const piece = rest.slice(0, take)
      lines.push(piece)
      rest = rest.slice(piece.length)
      if (rest.length > 0) flush()
    }
  }
  flush()
  return out
}
