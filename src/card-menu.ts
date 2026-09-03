/**
 * The interactive menu layer behind `/ws` `/ws new` `/model` `/session`
 * (R32): a registry of live menus plus pure card builders. No I/O here —
 * the bridge owns timers, sending, and the actual switch/register actions.
 *
 * Boundaries:
 * - One LIVE menu per (scope, kind): registering a new one retires the old,
 *   so a stale card can never act twice.
 * - Click payloads carry only `{menuId, act, idx}` — the menu's option
 *   snapshot lives server-side, keeping values tiny and un-forgeable.
 * - `select_static` options carry the compact string value form (Feishu
 *   echoes strings for selects), buttons the object form; both decode via
 *   cards.ts.
 * @module feishu4dsh/card-menu
 */

import { actionRow, card, encodeMenuValue, markdownElement, noteElement, type CardButton, type MenuAct } from './cards.js'

/** What a menu drives. */
export type MenuKind = 'ws' | 'model' | 'session' | 'browse'

/** How long a menu card stays clickable. */
export const MENU_TTL_MS = 15 * 60_000

/** Buttons per action row on menu cards. */
const BUTTONS_PER_ROW = 2

/** Options per page on a paginated menu. */
export const MENU_PAGE_SIZE = 15

/** Directory entries per page on a browse card. */
export const BROWSE_PAGE_SIZE = 8

/** One clickable entry of a list menu. */
export interface MenuOption {
  readonly label: string
  /** Marks the active entry (rendered with the ✅ prefix, not clickable). */
  readonly disabled?: boolean
}

/** Live state of one menu card. JSON-shaped except for the option list. */
export interface MenuState {
  readonly id: string
  readonly kind: MenuKind
  /** Chat the card was sent to; a forward to another chat must not act. */
  readonly chatId: string
  /** Scope the menu belongs to; registering a new menu retires this one. */
  readonly scopeKey: string
  readonly createdAt: number
  readonly expiresAt: number
  /** List menus (ws / model / session): the option snapshot. */
  readonly options: readonly MenuOption[]
  /** Browse menus only: the directory being viewed (moves on enter/up). */
  cwd?: string
  /** Browse menus only: subdirectory names at {@link cwd}. */
  entries?: readonly string[]
  /** Browse menus only: the allowed root the browse started from. */
  readonly root?: string
  /** ws menus only: the absolute path behind each option (same order). */
  readonly paths?: readonly string[]
  /** session menus only: full-list index behind each option (== /session <n>). */
  readonly indexMap?: readonly number[]
  page: number
  /** Filled by the bridge once the card message has been sent. */
  messageId?: string
}

/** Registry of live menus: at most one per (scopeKey, kind). */
export class MenuRegistry {
  private readonly byId = new Map<string, MenuState>()

  /** Register a menu, retiring any previous menu of the same scope+kind. */
  put(state: MenuState): void {
    for (const [id, existing] of [...this.byId]) {
      if (existing.scopeKey === state.scopeKey && existing.kind === state.kind) this.byId.delete(id)
    }
    this.byId.set(state.id, state)
  }

  /** Resolve a click's menu: undefined = unknown card; 'expired' = too old. */
  get(id: string, now: number): MenuState | 'expired' | undefined {
    const state = this.byId.get(id)
    if (state === undefined) return undefined
    if (now >= state.expiresAt) {
      this.byId.delete(id)
      return 'expired'
    }
    return state
  }

  /** One menu was acted on and is done. */
  remove(id: string): void {
    this.byId.delete(id)
  }

  /** Drop every menu of one scope (session switch / `/new` hygiene). */
  invalidateScope(scopeKey: string): void {
    for (const [id, state] of [...this.byId]) {
      if (state.scopeKey === scopeKey) this.byId.delete(id)
    }
  }

  clear(): void {
    this.byId.clear()
  }

  get size(): number {
    return this.byId.size
  }

  /** All live menus (dispose sweeps timers). */
  all(): readonly MenuState[] {
    return [...this.byId.values()]
  }
}

/** A short random menu id (URL/`|`-safe). */
export function createMenuId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/** Options on one page. */
export function pagedOptions<T>(options: readonly T[], page: number, pageSize: number): readonly T[] {
  const start = Math.max(0, page) * pageSize
  return options.slice(start, start + pageSize)
}

/** Total page count for an option list. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * The shared label set the bridge passes in (from `state.copy`), keeping
 * this module copy-agnostic.
 */
export interface MenuLabels {
  readonly prev: string
  readonly next: string
  readonly pageOf: (page: number, total: number) => string
  readonly placeholder: string
  readonly expiredNote: string
}

/** Buttons for one menu row chunk, values carrying the click payload. */
function menuButton(label: string, value: Record<string, unknown>, disabled?: boolean): CardButton {
  return { label: disabled === true ? `✅ ${label}` : label, value, style: 'default' }
}

function chunkButtons(buttons: CardButton[]): object[] {
  const rows: object[] = []
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(actionRow(buttons.slice(i, i + BUTTONS_PER_ROW)))
  }
  return rows
}

function menuButtonValue(chatId: string, menuId: string, act: MenuAct, idx?: number): Record<string, unknown> {
  const value: Record<string, unknown> = { kind: 'menu', menuId, act, chatId }
  if (idx !== undefined) value.idx = idx
  return value
}

/** The `/ws` card: one button per registered workspace (current marked). */
export function wsMenuCard(
  chatId: string,
  menu: MenuState,
  paths: readonly string[],
  labels: { note: string; title: string },
): object {
  const buttons = menu.options.map((option, i) =>
    menuButton(option.label, menuButtonValue(chatId, menu.id, 'sel', i), option.disabled))
  const elements: object[] = []
  if (paths.length > 0) {
    elements.push(markdownElement(paths.map(p => `- ${p}`).join('\n')))
  }
  elements.push(...chunkButtons(buttons))
  elements.push(noteElement(labels.note))
  return card({ title: labels.title, template: 'blue' }, elements)
}

/** The `/model` card: a select menu over the catalog plus pagination. */
export function modelMenuCard(
  chatId: string,
  menu: MenuState,
  labels: MenuLabels & { title: string },
): object {
  const total = pageCount(menu.options.length, MENU_PAGE_SIZE)
  const page = Math.min(Math.max(0, menu.page), total - 1)
  const slice = pagedOptions(menu.options, page, MENU_PAGE_SIZE)
  const start = page * MENU_PAGE_SIZE
  const select = {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: labels.placeholder },
    value: '',
    options: slice.map((option, i) => ({
      text: { tag: 'plain_text', content: option.disabled === true ? `✅ ${option.label}` : option.label },
      value: encodeMenuValue(menu.id, 'sel', chatId, start + i),
    })),
  }
  const elements: object[] = [{ tag: 'action', actions: [select] }]
  if (total > 1) {
    const buttons: CardButton[] = []
    if (page > 0) buttons.push({ label: labels.prev, value: menuButtonValue(chatId, menu.id, 'page', page - 1) })
    buttons.push({ label: labels.pageOf(page + 1, total), value: menuButtonValue(chatId, menu.id, 'page', page) })
    if (page < total - 1) buttons.push({ label: labels.next, value: menuButtonValue(chatId, menu.id, 'page', page + 1) })
    elements.push(actionRow(buttons))
  }
  elements.push(noteElement(labels.expiredNote))
  return card({ title: labels.title, template: 'blue' }, elements)
}

/** The `/session` card: one button per visible session (current marked). */
export function sessionMenuCard(
  chatId: string,
  menu: MenuState,
  labels: { note: string; title: string },
): object {
  const buttons = menu.options.map((option, i) =>
    menuButton(option.label, menuButtonValue(chatId, menu.id, 'sel', i), option.disabled))
  const elements = [...chunkButtons(buttons), noteElement(labels.note)]
  return card({ title: labels.title, template: 'blue' }, elements)
}

/** Labels the browse card needs. */
export interface BrowseLabels {
  readonly title: (path: string) => string
  readonly empty: string
  readonly confirm: string
  readonly parent: string
  readonly note: string
  readonly prev: string
  readonly next: string
  readonly pageOf: (page: number, total: number) => string
}

/** The `/ws new` card: browse directories level by level, confirm to use. */
export function browseCard(
  chatId: string,
  menu: MenuState,
  labels: BrowseLabels,
): object {
  const cwd = menu.cwd ?? ''
  const entries = menu.entries ?? []
  const total = pageCount(entries.length, BROWSE_PAGE_SIZE)
  const page = Math.min(Math.max(0, menu.page), total - 1)
  const slice = pagedOptions(entries, page, BROWSE_PAGE_SIZE)
  const start = page * BROWSE_PAGE_SIZE
  const elements: object[] = [markdownElement(`📁 \`${cwd}\``)]
  if (entries.length === 0) {
    elements.push(markdownElement(labels.empty))
  } else {
    const buttons = slice.map((name, i) =>
      ({ label: `📁 ${name}`, value: menuButtonValue(chatId, menu.id, 'sel', start + i), style: 'default' as const }))
    elements.push(...chunkButtons(buttons))
  }
  if (total > 1) {
    const pageButtons: CardButton[] = []
    if (page > 0) pageButtons.push({ label: labels.prev, value: menuButtonValue(chatId, menu.id, 'page', page - 1) })
    pageButtons.push({ label: labels.pageOf(page + 1, total), value: menuButtonValue(chatId, menu.id, 'page', page) })
    if (page < total - 1) pageButtons.push({ label: labels.next, value: menuButtonValue(chatId, menu.id, 'page', page + 1) })
    elements.push(actionRow(pageButtons))
  }
  const navButtons: CardButton[] = []
  if (cwd !== menu.root) navButtons.push({ label: labels.parent, value: menuButtonValue(chatId, menu.id, 'up') })
  navButtons.push({ label: labels.confirm, value: menuButtonValue(chatId, menu.id, 'ok'), style: 'primary' })
  elements.push(actionRow(navButtons))
  elements.push(noteElement(labels.note))
  return card({ title: labels.title(cwd), template: 'green' }, elements)
}

/** The settled card replacing a menu after a successful action. */
export function menuDoneCard(title: string, body: string): object {
  return card({ title, template: 'green' }, [markdownElement(body)])
}

/** The expired card replacing a menu whose TTL ran out (timer or lazy click). */
export function menuExpiredCard(note: string): object {
  return card({ title: '⏳', template: 'grey' }, [noteElement(note)])
}
