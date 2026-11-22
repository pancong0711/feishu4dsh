/**
 * Deterministic `/she` command parser. No model parses or rewrites tasks.
 * @module feishu4dsh/secretary/command
 */

export type SheCommand =
  /** Help query; `topic` absent means the global command list. */
  | { readonly kind: 'help'; readonly topic?: string }
  /** One-shot B-side initialization; optional repo name overrides the source basename. */
  | { readonly kind: 'init'; readonly repoName?: string }
  /** Read-only SHE/OpenCode/runtime diagnostics. */
  | { readonly kind: 'doctor' }
  | { readonly kind: 'submit'; readonly raw: string }
  | { readonly kind: 'continue'; readonly topic: string; readonly raw: string }
  | { readonly kind: 'list'; readonly topic?: string }
  | { readonly kind: 'status'; readonly reference: string }
  | { readonly kind: 'report'; readonly reference: string }
  | { readonly kind: 'stop'; readonly reference: string }
  | { readonly kind: 'resume'; readonly reference: string }
  | { readonly kind: 'rename'; readonly oldRef: string; readonly newLabel: string; readonly force: boolean }
  | { readonly kind: 'remove'; readonly reference: string; readonly purge: boolean }
  | { readonly kind: 'invalid'; readonly reason: string }

function restAfter(text: string, prefix: string): string {
  return text.slice(prefix.length).replace(/^\s+/, '')
}

function helpTopicOf(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (value === 'topic rename' || value === 'rename') return 'rename'
  if (value === 'topic remove' || value === 'remove') return 'remove'
  return value
}

function helpFor(topic: string | undefined): SheCommand {
  return topic === undefined || topic === '' ? { kind: 'help' } : { kind: 'help', topic: helpTopicOf(topic) }
}

/**
 * Parse the text after `/she`. `submit` and `continue` preserve the raw
 * request body verbatim apart from the leading separator whitespace.
 *
 * Help is recognized before action parsing so `/she init help`,
 * `/she init --help` and `/she help init` never create a repo named "help"
 * or submit a task body containing only the word "help".
 */
export function parseSheCommand(text: string): SheCommand {
  const line = text.trim()
  if (line === '' || line === 'help' || line === '?') return helpFor(undefined)

  // `help <topic>` and `<topic> --help|-h|help` are unambiguous help queries.
  if (line.startsWith('help ')) return helpFor(line.slice(5))
  if (/\s--help$/.test(line)) return helpFor(line.replace(/\s--help$/, ''))
  if (/\s-h$/.test(line)) return helpFor(line.replace(/\s-h$/, ''))
  if (/\shelp$/.test(line)) return helpFor(line.replace(/\shelp$/, ''))
  if (line === 'init') return { kind: 'init' }
  if (line.startsWith('init ')) {
    const parts = line.slice(5).trim().split(/\s+/).filter(Boolean)
    if (parts.length > 1) return { kind: 'invalid', reason: 'init_usage' }
    return { kind: 'init', repoName: parts[0] }
  }
  if (line === 'doctor') return { kind: 'doctor' }
  if (line === 'submit' || line.startsWith('submit ')) {
    const raw = restAfter(line, 'submit')
    return raw === '' ? { kind: 'invalid', reason: 'submit_usage' } : { kind: 'submit', raw }
  }
  if (line === 'continue' || line.startsWith('continue ')) {
    const rest = restAfter(line, 'continue')
    const match = /^(\S+)\s+([\s\S]+)$/.exec(rest)
    if (match?.[1] === undefined || match[2] === undefined) return { kind: 'invalid', reason: 'continue_usage' }
    return { kind: 'continue', topic: match[1], raw: match[2] }
  }
  if (line === 'list') return { kind: 'list' }
  if (line.startsWith('list ')) {
    const topic = line.slice(5).trim()
    return topic === '' ? { kind: 'invalid', reason: 'list_usage' } : { kind: 'list', topic }
  }
  if (line.startsWith('status ')) {
    const ref = line.slice(7).trim()
    return ref === '' ? { kind: 'invalid', reason: 'status_usage' } : { kind: 'status', reference: ref }
  }
  if (line.startsWith('report ')) {
    const ref = line.slice(7).trim()
    return ref === '' ? { kind: 'invalid', reason: 'report_usage' } : { kind: 'report', reference: ref }
  }
  if (line.startsWith('stop ')) {
    const ref = line.slice(5).trim()
    return ref === '' ? { kind: 'invalid', reason: 'stop_usage' } : { kind: 'stop', reference: ref }
  }
  if (line.startsWith('resume ')) {
    const ref = line.slice(7).trim()
    return ref === '' ? { kind: 'invalid', reason: 'resume_usage' } : { kind: 'resume', reference: ref }
  }
  if (line.startsWith('topic rename ')) {
    const rest = line.slice('topic rename '.length).trim()
    const parts = rest.split(/\s+/)
    const oldRef = parts[0]
    const newLabel = parts[1]
    const force = parts.includes('--force')
    if (oldRef === undefined || newLabel === undefined || parts.length > (force ? 3 : 2)) {
      return { kind: 'invalid', reason: 'rename_usage' }
    }
    return { kind: 'rename', oldRef, newLabel, force }
  }
  if (line.startsWith('topic remove ')) {
    const rest = line.slice('topic remove '.length).trim()
    const parts = rest.split(/\s+/)
    const reference = parts[0]
    const purge = parts.includes('--purge')
    if (reference === undefined || parts.length > (purge ? 2 : 1)) {
      return { kind: 'invalid', reason: 'remove_usage' }
    }
    return { kind: 'remove', reference, purge }
  }
  return { kind: 'invalid', reason: 'unknown' }
}
