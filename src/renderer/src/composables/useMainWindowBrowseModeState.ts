import { watch } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { MainWindowBrowseMode } from '@renderer/utils/mainWindowPlaybackHandoff'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

const normalizeMainWindowBrowseMode = (value: unknown): MainWindowBrowseMode =>
  value === 'horizontal' || value === 'edit' ? value : 'browser'

const resolveRuntimePlatform = (platform: unknown) =>
  platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : 'Unknown'

export const useMainWindowBrowseModeState = (runtime: RuntimeStore) => {
  runtime.platform = resolveRuntimePlatform(runtime.setting?.platform)
  runtime.mainWindowBrowseMode = normalizeMainWindowBrowseMode(
    runtime.setting?.mainWindowBrowseMode
  )
  watch(
    () => runtime.mainWindowBrowseMode,
    (mode) => {
      const normalizedMode = normalizeMainWindowBrowseMode(mode)
      if (runtime.mainWindowBrowseMode !== normalizedMode) {
        runtime.mainWindowBrowseMode = normalizedMode
        return
      }
      if (runtime.setting?.mainWindowBrowseMode !== normalizedMode) {
        runtime.setting.mainWindowBrowseMode = normalizedMode
      }
      window.electron.ipcRenderer.send('main-window-browse-mode-updated', normalizedMode)
    },
    { immediate: true }
  )
}
