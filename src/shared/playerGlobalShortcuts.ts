import type { IPlayerGlobalShortcuts, PlayerGlobalShortcutAction } from '../types/globals'

export const DEFAULT_PLAYER_GLOBAL_SHORTCUTS: IPlayerGlobalShortcuts = {
  togglePlayPause: 'Shift+Alt+Space',
  fastForward: 'Shift+Alt+Right',
  fastBackward: 'Shift+Alt+Left',
  nextSong: 'Shift+Alt+Down',
  previousSong: 'Shift+Alt+Up',
  seekPercentModifier: 'Shift+Alt'
}

export const PLAYER_GLOBAL_SHORTCUT_ACTIONS: PlayerGlobalShortcutAction[] = [
  'togglePlayPause',
  'fastForward',
  'fastBackward',
  'nextSong',
  'previousSong'
]

export type PlayerGlobalShortcutIpcPayload =
  | { action: PlayerGlobalShortcutAction }
  | { action: 'seekPercent'; percent: number }

export type PlayerGlobalSeekPercentBinding = {
  key: string
  percent: number
  optional?: boolean
}

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt'] as const
type SeekPercentModifierToken = (typeof MODIFIER_ORDER)[number]

const sanitizeShortcut = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value : fallback

const canonicalModifierToken = (raw: string): SeekPercentModifierToken | 'rejected' | null => {
  const key = raw.trim().toLowerCase()
  if (!key) return null
  if (key === 'ctrl' || key === 'control') return 'Ctrl'
  if (key === 'alt' || key === 'option') return 'Alt'
  if (key === 'shift') return 'Shift'
  return 'rejected'
}

export const SEEK_PERCENT_KEY_BINDINGS: PlayerGlobalSeekPercentBinding[] = [
  { key: '`', percent: 0, optional: true },
  { key: '1', percent: 0.1 },
  { key: '2', percent: 0.2 },
  { key: '3', percent: 0.3 },
  { key: '4', percent: 0.4 },
  { key: '5', percent: 0.5 },
  { key: '6', percent: 0.6 },
  { key: '7', percent: 0.7 },
  { key: '8', percent: 0.8 },
  { key: '9', percent: 0.9 },
  { key: '0', percent: 1 },
  { key: 'num1', percent: 0.1 },
  { key: 'num2', percent: 0.2 },
  { key: 'num3', percent: 0.3 },
  { key: 'num4', percent: 0.4 },
  { key: 'num5', percent: 0.5 },
  { key: 'num6', percent: 0.6 },
  { key: 'num7', percent: 0.7 },
  { key: 'num8', percent: 0.8 },
  { key: 'num9', percent: 0.9 },
  { key: 'num0', percent: 1 }
]

export function normalizeSeekPercentModifier(value: string): string {
  const tokens = value
    .split('+')
    .map((item) => item.trim())
    .filter(Boolean)
  if (tokens.length === 0) return ''
  const present = new Set<SeekPercentModifierToken>()
  for (const token of tokens) {
    const canonical = canonicalModifierToken(token)
    if (canonical === null) continue
    if (canonical === 'rejected') return ''
    present.add(canonical)
  }
  if (!present.has('Ctrl') && !present.has('Alt')) return ''
  return MODIFIER_ORDER.filter((item) => present.has(item)).join('+')
}

export function parseSeekPercentModifierInput(
  value: string
): { ok: true; modifier: string } | { ok: false } {
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, modifier: '' }
  const normalized = normalizeSeekPercentModifier(trimmed)
  if (!normalized) return { ok: false }
  return { ok: true, modifier: normalized }
}

const sanitizeSeekPercentModifierField = (value: unknown): string => {
  if (value === undefined || value === null) {
    return DEFAULT_PLAYER_GLOBAL_SHORTCUTS.seekPercentModifier
  }
  if (typeof value !== 'string') return ''
  const parsed = parseSeekPercentModifierInput(value)
  return parsed.ok ? parsed.modifier : ''
}

export function sanitizePlayerGlobalShortcuts(
  value: Partial<IPlayerGlobalShortcuts> | undefined | null
): IPlayerGlobalShortcuts {
  const base = { ...DEFAULT_PLAYER_GLOBAL_SHORTCUTS }
  if (!value || typeof value !== 'object') {
    return base
  }
  return {
    togglePlayPause: sanitizeShortcut(value.togglePlayPause, base.togglePlayPause),
    fastForward: sanitizeShortcut(value.fastForward, base.fastForward),
    fastBackward: sanitizeShortcut(value.fastBackward, base.fastBackward),
    nextSong: sanitizeShortcut(value.nextSong, base.nextSong),
    previousSong: sanitizeShortcut(value.previousSong, base.previousSong),
    seekPercentModifier: sanitizeSeekPercentModifierField(value.seekPercentModifier)
  }
}

export function buildSeekPercentAccelerators(modifier: string): Array<{
  accelerator: string
  percent: number
  key: string
  optional?: boolean
}> {
  const prefix = normalizeSeekPercentModifier(modifier)
  if (!prefix) return []
  return SEEK_PERCENT_KEY_BINDINGS.map((binding) => ({
    accelerator: `${prefix}+${binding.key}`,
    percent: binding.percent,
    key: binding.key,
    optional: binding.optional
  }))
}

export function formatSeekPercentModifierSettingValue(modifier: string): string {
  const normalized = normalizeSeekPercentModifier(modifier)
  if (!normalized) return ''
  return `${normalized} + 1~0 / ~`
}

export function isPlayerGlobalShortcutAction(value: unknown): value is PlayerGlobalShortcutAction {
  return (
    value === 'togglePlayPause' ||
    value === 'fastForward' ||
    value === 'fastBackward' ||
    value === 'nextSong' ||
    value === 'previousSong'
  )
}

export function normalizePlayerGlobalShortcutPayload(
  payload: unknown
): PlayerGlobalShortcutIpcPayload | null {
  if (typeof payload === 'string') {
    return isPlayerGlobalShortcutAction(payload) ? { action: payload } : null
  }
  if (!payload || typeof payload !== 'object') return null
  if (!('action' in payload)) return null
  const action = payload.action
  if (action === 'seekPercent') {
    const rawPercent = 'percent' in payload ? payload.percent : undefined
    const percent = typeof rawPercent === 'number' ? rawPercent : Number(rawPercent)
    if (!Number.isFinite(percent)) return null
    return { action: 'seekPercent', percent }
  }
  if (isPlayerGlobalShortcutAction(action)) {
    return { action }
  }
  return null
}
