import type { IPlayerGlobalShortcuts, PlayerGlobalShortcutAction } from '../types/globals'

export const DEFAULT_PLAYER_GLOBAL_SHORTCUTS: IPlayerGlobalShortcuts = {
  togglePlayPause: 'Shift+Alt+Space',
  fastForward: 'Shift+Alt+Right',
  fastBackward: 'Shift+Alt+Left',
  nextSong: 'Shift+Alt+Down',
  previousSong: 'Shift+Alt+Up'
}

export const PLAYER_GLOBAL_SHORTCUT_ACTIONS: PlayerGlobalShortcutAction[] = [
  'togglePlayPause',
  'fastForward',
  'fastBackward',
  'nextSong',
  'previousSong'
]

const sanitizeShortcut = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value : fallback

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
    previousSong: sanitizeShortcut(value.previousSong, base.previousSong)
  }
}
