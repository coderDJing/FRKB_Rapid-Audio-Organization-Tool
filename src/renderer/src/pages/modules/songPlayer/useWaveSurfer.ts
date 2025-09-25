import WaveSurfer from 'wavesurfer.js'
import { onMounted, onUnmounted } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'

export function useWaveSurfer(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  waveformEl: Ref<HTMLDivElement | null>
  wavesurferInstance: ShallowRef<WaveSurfer | null>
  updateParentWaveformWidth: () => void
  onNextSong: () => void
  schedulePreloadAfterPlay: () => void
  cancelPreloadTimer: () => void
  playerControlsRef?: { value?: { setPlayingValue?: (v: boolean) => void } | null }
  onError?: (error: any) => void
}) {
  const {
    runtime,
    waveformEl,
    wavesurferInstance,
    updateParentWaveformWidth,
    onNextSong,
    schedulePreloadAfterPlay,
    cancelPreloadTimer,
    playerControlsRef,
    onError
  } = params

  const canvas = document.createElement('canvas')
  canvas.height = 50
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('ctx is null')
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  gradient.addColorStop(0, '#cccccc')
  gradient.addColorStop(1, '#cccccc')
  const progressGradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  progressGradient.addColorStop(0, '#0078d4')
  progressGradient.addColorStop(1, '#0078d4')

  const createWaveSurferInstance = (container: HTMLDivElement): WaveSurfer => {
    return WaveSurfer.create({
      container,
      waveColor: gradient,
      progressColor: progressGradient,
      barWidth: 2,
      autoplay: false,
      height: 40
    })
  }

  const attachEventListeners = (targetInstance: WaveSurfer) => {
    if (!targetInstance) return

    const timeEl = document.querySelector('#time')
    const durationEl = document.querySelector('#duration')
    if (!timeEl || !durationEl) return

    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    targetInstance.on('decode', (duration) => {
      durationEl.textContent = formatTime(duration)
      updateParentWaveformWidth()
    })

    let previousTime = 0
    const jumpThreshold = 0.5

    targetInstance.on('timeupdate', (currentTime) => {
      ;(timeEl as HTMLElement).textContent = formatTime(currentTime)
      const deltaTime = currentTime - previousTime
      if (runtime.setting.enablePlaybackRange && targetInstance === wavesurferInstance.value) {
        const duration = targetInstance.getDuration()
        if (duration > 0) {
          const endPercent = runtime.setting.endPlayPercent ?? 100
          const endTime = (duration * endPercent) / 100
          if (
            currentTime >= endTime &&
            previousTime < endTime &&
            targetInstance.isPlaying() &&
            deltaTime < jumpThreshold
          ) {
            if (runtime.setting.autoPlayNextSong) onNextSong()
            else targetInstance.pause()
          }
        }
      }
      previousTime = currentTime
    })

    targetInstance.on('finish', () => {
      cancelPreloadTimer()
      if (runtime.setting.autoPlayNextSong) onNextSong()
    })

    targetInstance.on('pause', () => {
      cancelPreloadTimer()
      playerControlsRef?.value?.setPlayingValue?.(false)
    })

    targetInstance.on('play', () => {
      playerControlsRef?.value?.setPlayingValue?.(true)
      cancelPreloadTimer()
      schedulePreloadAfterPlay()
      runtime.playerReady = true
      runtime.isSwitchingSong = false
    })

    targetInstance.on('ready', () => {
      updateParentWaveformWidth()
    })

    if (onError) {
      targetInstance.on('error', (error: any) => {
        onError(error)
      })
    }
  }

  const detachEventListeners = (targetInstance: WaveSurfer) => {
    if (!targetInstance) return
    targetInstance.unAll()
  }

  onMounted(() => {
    if (!waveformEl.value) return
    wavesurferInstance.value = createWaveSurferInstance(waveformEl.value)
    attachEventListeners(wavesurferInstance.value)
  })

  onUnmounted(() => {
    if (wavesurferInstance.value) {
      detachEventListeners(wavesurferInstance.value)
      wavesurferInstance.value.destroy()
      wavesurferInstance.value = null
    }
  })

  return {
    createWaveSurferInstance,
    attachEventListeners,
    detachEventListeners
  }
}
