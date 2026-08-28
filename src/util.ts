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
