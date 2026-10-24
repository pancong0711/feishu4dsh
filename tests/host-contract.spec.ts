import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { TURN_END_KINDS } from '../src/host.js'

/**
 * R47 (F2) + R50: the host contract is the plugin's ONE upgrade surface, so it
 * is checked twice over —
 *
 * 1. **Internally**: the shipped vocabulary constant and the source files that
 *    compare against it must agree, and fixtures may not invent words. This
 *    runs everywhere (no host needed).
 * 2. **Against the installed host**: when a dsh installation is reachable, the
 *    `.d.ts` shapes this plugin mirrors are parsed and compared, so a host
 *    upgrade turns CI red instead of turning `/stop`, `/compact`, or
 *    `/session archive` silently dead at runtime.
 *
 * The 2026-10-21 (dsh 0.2.1-rc.2) incident is why layer 2 exists: 332 green
 * unit tests all ran against hand-written fakes that had frozen the OLD
 * signatures, so four real breaks shipped green.
 */

const SRC = join(import.meta.dirname, '..', 'src')

/** Every source file's text, keyed by file name. */
function srcFiles(): { name: string; source: string }[] {
  return readdirSync(SRC)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, source: readFileSync(join(SRC, name), 'utf8') }))
}

/**
 * Locate an installed dsh's `@deepseek-ai/*` package directory.
 * @returns the directory holding `dsh-session/`, or undefined when this
 *   checkout has no host installed (standalone build/test).
 */
function hostPackagesDir(): string | undefined {
  const candidates = [
    process.env.FEISHU4DSH_DSH_PACKAGES,
    join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  ].filter((entry): entry is string => entry !== undefined && entry !== '')
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh-session', 'lib', 'types', 'types.d.ts'))) return candidate
  }
  return undefined
}

/** Read one host type file, or undefined when this host does not ship it. */
function hostTypeFile(root: string, pkg: string, ...rest: string[]): string | undefined {
  const path = join(root, pkg, 'lib', 'types', ...rest)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

describe('host contract: turn/end reason vocabulary (internal)', () => {
  const ALLOWED = new Set<string>([...TURN_END_KINDS])

  it('the shipped constant matches the 0.2.1 host TurnEndReasonMap keys', () => {
    expect([...TURN_END_KINDS].sort()).toEqual(
      ['aborted', 'blocked', 'completed', 'error', 'forked', 'interrupted', 'max-tokens'],
    )
  })

  it('no src file compares reason.kind against a string outside the host vocabulary', () => {
    const offenders: string[] = []
    for (const { name, source } of srcFiles()) {
      // Matches: reason.kind === 'x' / !== 'x' and kind: 'x' literal comparisons.
      for (const match of source.matchAll(/reason\.kind\s*[!=]==\s*'([a-z-]+)'/g)) {
        const literal = String(match[1])
        if (!ALLOWED.has(literal)) offenders.push(`${name}: reason.kind compared to '${literal}'`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('test fixtures may only build turn/end reasons from the same vocabulary', () => {
    // Self-check for the fixture corpus: the sweep (R47 F3) must not regress.
    const source = readFileSync(join(import.meta.dirname, 'bridge.spec.ts'), 'utf8')
    // Only turn/end reason objects — other fixtures legitimately use `kind`
    // (approval outcomes, command results), so match the nested shape.
    const found = [...source.matchAll(/reason:\s*\{[^{}]*?kind:\s*'([a-z-]+)'/g)].map(m => String(m[1]))
    const fake = found.filter(kind => !ALLOWED.has(kind))
    expect([...new Set(fake)]).toEqual([])
  })
})

describe('host contract: cancel causes (internal)', () => {
  it('every agent.cancel() call passes the structured cause, never a bare string', () => {
    const offenders: string[] = []
    for (const { name, source } of srcFiles()) {
      // `.cancel('…')` / `.cancel(`…`)` — the 0.2.1 host `assertNever`s a string.
      for (const match of source.matchAll(/\.cancel\(\s*['"`]/g)) {
        offenders.push(`${name}: agent.cancel called with a string literal`)
      }
      // Any non-literal argument must go through the typed helper.
      for (const match of source.matchAll(/\.cancel\(\s*([A-Za-z_$][\w$]*)/g)) {
        const arg = String(match[1])
        if (arg !== 'hookCancel') offenders.push(`${name}: agent.cancel argument '${arg}' is not hookCancel(...)`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('host contract: command dispatch (internal)', () => {
  it('commands.execute is called with the attachment batch before the signal', () => {
    const bridge = readFileSync(join(SRC, 'bridge.ts'), 'utf8')
    const calls = [...bridge.matchAll(/commands\.execute\(([^)]*)\)/g)].map(m => String(m[1]))
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      // agent, line, submittedAttachments, signal
      expect(args.split(',').length).toBe(4)
      expect(args).toMatch(/\[\]\s*,\s*[\w.]+$/)
    }
  })
})

describe('host contract: archive set is a value (internal)', () => {
  it('archivedSessionIds is read as a property, never invoked', () => {
    const offenders: string[] = []
    for (const { name, source } of srcFiles()) {
      // Ignore doc comments: the R50 note quotes the host's getter by name.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      if (/archivedSessionIds\s*\(/.test(code)) offenders.push(`${name}: archivedSessionIds invoked as a function`)
    }
    expect(offenders).toEqual([])
  })
})

describe('host contract: session log accessor (internal)', () => {
  it('only the host adapter reads the legacy `session.events` property', () => {
    const offenders: string[] = []
    for (const { name, source } of srcFiles()) {
      if (name === 'host.ts') continue
      if (/\bsession\.events\b/.test(source)) offenders.push(`${name}: reads session.events directly`)
      if (/\?\.events\b/.test(source)) offenders.push(`${name}: reads ?.events directly`)
    }
    expect(offenders).toEqual([])
  })
})

const hostRoot = hostPackagesDir()

describe.skipIf(hostRoot === undefined)('host contract: installed dsh types', () => {
  it('TURN_END_KINDS matches the installed TurnEndReasonMap', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-session', 'types.d.ts')
    expect(source).toBeDefined()
    const block = /interface TurnEndReasonMap \{([\s\S]*?)\n\}/.exec(source as string)?.[1] ?? ''
    const keys = [...block.matchAll(/^\s{4}'?([a-z][a-z-]*)'?: \{/gm)].map(m => String(m[1]))
    expect(keys.length).toBeGreaterThan(0)
    expect([...TURN_END_KINDS].sort()).toEqual([...keys].sort())
  })

  it('AgentCancelCause is the closed union the plugin mirrors', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-session', 'types.d.ts') as string
    // The union's members each carry `;` inside, so bound it by the NEXT
    // declaration rather than by the first semicolon.
    const block = /export type AgentCancelCause =([\s\S]*?)export type TurnEndCancelCause/.exec(source)?.[1] ?? ''
    const kinds = [...block.matchAll(/kind: '([a-z]+)'/g)].map(m => String(m[1]))
    expect(kinds.sort()).toEqual(['disposed', 'hook', 'parent', 'user'])
  })

  it('commands.execute takes (agent, line, submittedAttachments, signal)', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-commands', 'index.d.ts')
    expect(source).toBeDefined()
    const signature = /execute\(([^)]*)\)/.exec(source as string)?.[1] ?? ''
    expect(signature).toContain('submittedAttachments')
    expect(signature.indexOf('submittedAttachments')).toBeLessThan(signature.indexOf('signal'))
  })

  it('workspaceRegistry exposes archivedSessionIds as a getter', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-workspace', 'index.d.ts')
    expect(source).toBeDefined()
    expect(source as string).toMatch(/get archivedSessionIds\(\)/)
  })

  it('Session exposes snapshotEvents() and no `events` property', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-session', 'index.d.ts')
    expect(source).toBeDefined()
    expect(source as string).toContain('snapshotEvents(')
    expect(source as string).not.toMatch(/get events\(\)/)
  })

  it('sessionQuery observations are disposable leases', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-session-query', 'observation.d.ts')
    expect(source).toBeDefined()
    // Declared as a lease: disposable + retainable. The concrete disposer is a
    // `[Symbol.dispose]` method in the implementation (lib/index.js).
    expect(source as string).toMatch(/interface SessionObservation extends Disposable/)
    expect(source as string).toContain('retain()')
  })

  it('the ask_user waterfall is a separate event from approvals', () => {
    const source = hostTypeFile(hostRoot as string, 'dsh-user-questions', 'types.d.ts')
    expect(source).toBeDefined()
    expect(source as string).toContain("'user-questions/request'")
  })
})

/* ------------------------------------------------------------------ */
/* R54: shipped presets must actually assemble on the installed host    */
/* ------------------------------------------------------------------ */

/**
 * R52 and R53 were the same class of defect: a preset row copied from the
 * dsh-web-app reference drifted away from what the installed host accepts —
 * R52 omitted the host-scope service a `modelSelectionSettings: true` row
 * requires, R53 kept a `{{cwd}}` persona variable the 0.2.1 prompt loop no
 * longer registers. Neither broke composition (`--dump-config` stayed green)
 * and neither showed up on this machine, which runs `minimal` by default —
 * both only fired at runtime, on `standard`, for other users.
 *
 * Layer 1 here is host-free: every `{{name}}` the shipped patch interpolates
 * must be a variable the prompt loop actually provides. Layer 2 (host
 * reachable) renders both presets' persona text through the REAL host
 * interpolator, so a future variable rename fails here instead of in
 * someone's chat.
 */

/** Prompt variables the dsh prompt loop provides to every assembly. */
const HOST_PROMPT_VARIABLES = new Set(['provider', 'model'])

/** The persona prefix/suffix the shipped patch declares for one preset. */
function shippedPersona(preset: string): { prefix: string; suffix: string } {
  const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
  const start = patch.indexOf(`- id: preset-${preset}`)
  expect(start).toBeGreaterThan(-1)
  // The preset block ends at the next top-level `- insert:` or `- id:`.
  const rest = patch.slice(start)
  const end = rest.search(/\n- (insert|id):/)
  const block = end < 0 ? rest : rest.slice(0, end)
  const read = (key: string): string => {
    const match = block.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm'))
    return match?.[1]?.trim() ?? ''
  }
  return { prefix: read('prefix'), suffix: read('suffix') }
}

/** Strip YAML comments so documentation of a removed clause is not mistaken for it. */
function livePatchText(): string {
  return readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    .split('\n')
    .map(line => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

describe('host contract: shipped presets assemble (internal)', () => {
  it('every interpolated name is a variable the prompt loop provides', () => {
    const refs = [...livePatchText().matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map(match => String(match[1]))
    const unknown = [...new Set(refs)].filter(name => !HOST_PROMPT_VARIABLES.has(name))
    // R53: `cwd` used to be here and threw `unknown prompt variable` on every
    // turn of a fresh `standard` session.
    expect(unknown).toEqual([])
  })

  it('both shipped presets declare a persona the loop can render', () => {
    for (const preset of ['standard', 'minimal']) {
      const { prefix, suffix } = shippedPersona(preset)
      expect(prefix.length, `preset ${preset} must declare a persona prefix`).toBeGreaterThan(0)
      for (const text of [prefix, suffix]) {
        for (const match of text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) {
          expect(HOST_PROMPT_VARIABLES.has(String(match[1])), `preset ${preset}: {{${String(match[1])}}}`).toBe(true)
        }
      }
    }
  })

  it('no preset declares an empty persona suffix (the R53 shape)', () => {
    // An empty-after-removal `suffix:` key is legal but pointless; the R53 fix
    // removed the key entirely, and dsh-persona defaults it to ''.
    for (const preset of ['standard', 'minimal']) {
      const { suffix } = shippedPersona(preset)
      if (suffix !== '') expect(suffix.length).toBeGreaterThan(0)
    }
  })
})

describe('host contract: shipped presets assemble (installed host)', () => {
  const hostRoot = hostPackagesDir()

  it.skipIf(hostRoot === undefined)('both presets render through the real host interpolator', async () => {
    // Load the real dsh-system-prompt and render each preset's persona exactly
    // as the host does: strict `{{name}}` interpolation over the loop's
    // variables. R53 failed here with `unknown prompt variable "{{cwd}}"`.
    const entry = join(hostRoot as string, 'dsh-system-prompt', 'lib', 'index.js')
    expect(existsSync(entry)).toBe(true)
    const mod = (await import(entry)) as { renderPrompt?: (assembly: unknown) => string }
    expect(typeof mod.renderPrompt).toBe('function')
    const variables = { provider: 'deepseek', model: 'deepseek-v4' }
    for (const preset of ['standard', 'minimal']) {
      const { prefix, suffix } = shippedPersona(preset)
      const sections = [
        { name: `test:${preset}:prefix`, text: prefix },
        ...(suffix === '' ? [] : [{ name: `test:${preset}:suffix`, text: suffix }]),
      ]
      // Throws on any unregistered variable — the exact 0.2.1 failure mode.
      expect(() => mod.renderPrompt?.({ variables, sections, contexts: [] }), `preset ${preset}`).not.toThrow()
    }
  })
})
