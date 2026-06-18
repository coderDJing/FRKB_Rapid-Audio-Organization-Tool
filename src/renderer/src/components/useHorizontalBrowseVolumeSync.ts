import { onMounted, onUnmounted, ref } from 'vue'
import { clampNumber } from '@renderer/components/horizontalBrowseMath'
import emitter from '@renderer/utils/mitt'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_SET_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  clampVolumeValue,
  readWindowVolume
} from '@renderer/utils/windowVolume'

type UseHorizontalBrowseVolumeSyncParams = {
  nativeTransport: {
    state: {
      output?: {
        crossfaderValue?: number
      }
    }
    setOutputState: (crossfaderValue: number, masterGain: number) => Promise<unknown>
  }
}

export const useHorizontalBrowseVolumeSync = ({
  nativeTransport
}: UseHorizontalBrowseVolumeSyncParams) => {
  const mainWindowVolume = ref(readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY))

  const resolveCrossfaderValue = () =>
    clampNumber(Number(nativeTransport.state.output?.crossfaderValue) || 0, -1, 1)

  const handleMainWindowVolumeSync = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    mainWindowVolume.value = clampVolumeValue(value)
    void nativeTransport.setOutputState(resolveCrossfaderValue(), mainWindowVolume.value)
  }

  const syncCurrentVolume = () => {
    void nativeTransport.setOutputState(resolveCrossfaderValue(), mainWindowVolume.value)
  }

  onMounted(() => {
    emitter.on(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSync)
    emitter.on(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
    syncCurrentVolume()
  })

  onUnmounted(() => {
    emitter.off(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSync)
    emitter.off(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
  })

  return {
    mainWindowVolume,
    syncCurrentVolume
  }
}
