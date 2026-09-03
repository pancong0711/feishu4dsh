import { describe, expect, it } from 'vitest'
import {
  BROWSE_PAGE_SIZE, MENU_PAGE_SIZE, MenuRegistry, browseCard, createMenuId,
  modelMenuCard, pageCount, pagedOptions, wsMenuCard, type MenuState,
} from '../src/card-menu.js'
import { decodeActionValue, encodeMenuValue, parseMenuValue } from '../src/cards.js'

function menuOf(kind: MenuState['kind'], overrides?: Partial<MenuState>): MenuState {
  return {
    id: createMenuId(),
    kind,
    chatId: 'oc_chat1',
    scopeKey: 'oc_chat1',
    createdAt: 1_000,
    expiresAt: 2_000,
    page: 0,
    options: [],
    ...overrides,
  }
}

describe('MenuRegistry (R32)', () => {
  it('registers, resolves and expires menus', () => {
    const registry = new MenuRegistry()
    const menu = menuOf('ws')
    registry.put(menu)
    expect(registry.get(menu.id, 1_500)).toBe(menu)
    expect(registry.get(menu.id, 2_000)).toBe('expired')
    // Expired resolution consumes the entry.
    expect(registry.get(menu.id, 2_000)).toBeUndefined()
  })

  it('retires the previous menu of the same scope+kind on re-register', () => {
    const registry = new MenuRegistry()
    const first = menuOf('model')
    registry.put(first)
    const second = menuOf('model')
    registry.put(second)
    expect(registry.get(first.id, 1_500)).toBeUndefined()
    expect(registry.get(second.id, 1_500)).toBe(second)
    // A different scope keeps its own menu.
    const otherScope = menuOf('model', { scopeKey: 'oc_other' })
    registry.put(otherScope)
    expect(registry.get(second.id, 1_500)).toBe(second)
    registry.invalidateScope('oc_chat1')
    expect(registry.get(second.id, 1_500)).toBeUndefined()
    expect(registry.get(otherScope.id, 1_500)).toBe(otherScope)
  })
})

describe('menu value codec (R32)', () => {
  it('round-trips the compact string form for select options', () => {
    const encoded = encodeMenuValue('abc123', 'sel', 'oc_chat1', 7)
    const payload = parseMenuValue(encoded)
    expect(payload).toEqual({ kind: 'menu', menuId: 'abc123', act: 'sel', idx: 7, chatId: 'oc_chat1' })
    expect(decodeActionValue(encoded)).toEqual(payload)
    const noIdx = parseMenuValue(encodeMenuValue('abc123', 'ok', 'oc_chat1'))
    expect(noIdx).toMatchObject({ act: 'ok', idx: undefined })
  })

  it('rejects foreign or malformed values', () => {
    expect(parseMenuValue('m|only|four')).toBeNull()
    expect(parseMenuValue('x|a|sel|1|oc_chat1')).toBeNull()
    expect(parseMenuValue('m|a|nope|1|oc_chat1')).toBeNull()
    expect(decodeActionValue('not-a-menu|at|all')).toBeNull()
    expect(decodeActionValue({ kind: 'menu' })).toBeNull()
  })
})

describe('menu pagination (R32)', () => {
  it('slices options and counts pages', () => {
    const options = Array.from({ length: 7 }, (_, i) => `o${i}`)
    expect(pageCount(7, MENU_PAGE_SIZE)).toBe(1)
    expect(pageCount(7, 3)).toBe(3)
    expect(pagedOptions(options, 0, 3)).toEqual(['o0', 'o1', 'o2'])
    expect(pagedOptions(options, 2, 3)).toEqual(['o6'])
    // Out-of-range pages clamp to empty, never throw.
    expect(pagedOptions(options, 9, 3)).toEqual([])
  })
})

describe('menu card builders (R32)', () => {
  it('ws card: one button per workspace, current marked, values carry idx', () => {
    const menu = menuOf('ws', {
      options: [{ label: 'proj-a' }, { label: 'proj-b', disabled: true }],
      paths: ['/tmp/a', '/tmp/b'],
    })
    const cardObject = wsMenuCard('oc_chat1', menu, ['- proj-a — `/tmp/a`', '- proj-b — `/tmp/b`'], {
      note: 'note', title: 'title',
    })
    const buttons = (cardObject as { elements: { actions?: { value: Record<string, unknown> }[] }[] })
      .elements.flatMap(e => e.actions ?? [])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.value).toMatchObject({ kind: 'menu', act: 'sel', idx: 0 })
    expect(buttons[1]?.value).toMatchObject({ kind: 'menu', act: 'sel', idx: 1 })
    // The current workspace stays tappable-safe: decode marks it via options.
    expect(menu.options[1]?.disabled).toBe(true)
  })

  it('model card: select options use the string value form; pagination rows appear', () => {
    const options = Array.from({ length: MENU_PAGE_SIZE + 2 }, (_, i) => ({ label: `p/m${i}` }))
    const menu = menuOf('model', { options })
    const cardObject = modelMenuCard('oc_chat1', menu, {
      title: 'models', prev: 'prev', next: 'next', pageOf: (p, t) => `${p}/${t}`,
      placeholder: 'pick', expiredNote: 'note',
    })
    const actions = (cardObject as { elements: { actions?: { tag: string; options?: { value: string }[]; value?: Record<string, unknown> }[] }[] })
      .elements.flatMap(e => e.actions ?? [])
    const select = actions.find(a => a.tag === 'select_static')
    expect(select?.options).toHaveLength(MENU_PAGE_SIZE)
    const first = parseMenuValue(select?.options?.[0]?.value ?? '')
    expect(first).toMatchObject({ act: 'sel', idx: 0 })
    const next = actions.find(a => a.value?.act === 'page' && a.value?.idx === 1)
    expect(next).toBeDefined()
  })

  it('browse card: no parent at the root, parent+confirm deeper; pages entries', () => {
    const entries = Array.from({ length: BROWSE_PAGE_SIZE + 3 }, (_, i) => `dir${i}`)
    const root = menuOf('browse', { cwd: '/root', root: '/root', entries: [...entries] })
    const atRoot = browseCard('oc_chat1', root, {
      title: p => p, empty: 'empty', confirm: 'OK', parent: 'up', note: 'note',
      prev: 'prev', next: 'next', pageOf: (p, t) => `${p}/${t}`,
    })
    const buttonsOf = (c: object) => (c as { elements: { actions?: { value?: Record<string, unknown>; tag?: string }[] }[] })
      .elements.flatMap(e => e.actions ?? [])
    const rootButtons = buttonsOf(atRoot)
    expect(rootButtons.some(b => b.value?.act === 'up')).toBe(false)
    expect(rootButtons.some(b => b.value?.act === 'ok')).toBe(true)
    // First page only, with a next button.
    expect(rootButtons.filter(b => b.value?.act === 'sel')).toHaveLength(BROWSE_PAGE_SIZE)
    expect(rootButtons.some(b => b.value?.act === 'page' && b.value?.idx === 1)).toBe(true)

    const deeper = menuOf('browse', { cwd: '/root/child', root: '/root', entries: ['x'], page: 0 })
    const deepButtons = buttonsOf(browseCard('oc_chat1', deeper, {
      title: p => p, empty: 'empty', confirm: 'OK', parent: 'up', note: 'note',
      prev: 'prev', next: 'next', pageOf: (p, t) => `${p}/${t}`,
    }))
    expect(deepButtons.some(b => b.value?.act === 'up')).toBe(true)
  })
})
