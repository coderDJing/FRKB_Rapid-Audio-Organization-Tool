import type { useRuntimeStore } from '@renderer/stores/runtime'

type RuntimeStore = ReturnType<typeof useRuntimeStore>
type RuntimeLayoutConfig = RuntimeStore['layoutConfig']
type RuntimeLibraryTree = RuntimeStore['libraryTree']

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const isRuntimeLayoutConfig = (value: unknown): value is RuntimeLayoutConfig => {
  if (!isPlainRecord(value)) return false
  return (
    typeof value.libraryAreaWidth === 'number' &&
    typeof value.songsAreaSplitLeftRatio === 'number' &&
    typeof value.isMaxMainWin === 'boolean' &&
    typeof value.mainWindowWidth === 'number' &&
    typeof value.mainWindowHeight === 'number'
  )
}

export const isRuntimeLibraryTree = (value: unknown): value is RuntimeLibraryTree => {
  if (!isPlainRecord(value)) return false
  return (
    typeof value.uuid === 'string' &&
    (value.type === 'root' ||
      value.type === 'library' ||
      value.type === 'dir' ||
      value.type === 'songList' ||
      value.type === 'mixtapeList') &&
    typeof value.dirName === 'string'
  )
}

export const createLayoutConfigReadHandler =
  (runtime: RuntimeStore) => (_event: unknown, layoutConfig: unknown) => {
    if (!isRuntimeLayoutConfig(layoutConfig)) return
    runtime.layoutConfig = layoutConfig
  }
