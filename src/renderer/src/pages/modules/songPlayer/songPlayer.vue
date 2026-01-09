<script setup lang="ts">
import {
  ref,
  onMounted,
  onUnmounted,
  watch,
  useTemplateRef,
  computed,
  readonly,
  toRef,
  shallowRef,
  nextTick
} from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { IpcRendererEvent } from 'electron'
import { WebAudioPlayer } from './webAudioPlayer'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIconAsset from '@renderer/assets/musicIcon.png?asset'
import playerControls from '../../../components/playerControls.vue'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import BpmTap from './BpmTap.vue'
import PlaybackRangeHandles from './PlaybackRangeHandles.vue'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import { usePlayerControlsLogic } from './usePlayerControlsLogic'
import { useCover } from './useCover'
import { usePreloadNextSong } from './usePreloadNextSong'
import { useWaveform } from './useWaveform'
import emitter from '@renderer/utils/mitt'
import { useSongLoader } from './useSongLoader'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
const musicIcon = musicIconAsset

const runtime = useRuntimeStore()
const waveform = useTemplateRef<HTMLDivElement>('waveform')
const playerControlsRef = useTemplateRef('playerControlsRef')

const handleExternalOpenPlay = (payload: { songs?: ISongInfo[]; startIndex?: number }) => {
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  const queue = Array.isArray(payload?.songs)
    ? payload.songs.filter((item) => item && typeof item.filePath === 'string')
    : []
  if (!queue.length) return
  const normalizedQueue = queue.map((song) => ({ ...song }))
  const startIndexRaw = typeof payload?.startIndex === 'number' ? payload.startIndex : 0
  const startIndex = Math.min(Math.max(startIndexRaw, 0), normalizedQueue.length - 1)
  runtime.activeMenuUUID = ''
  runtime.songsArea.selectedSongFilePath = []
  runtime.playingData.playingSongListUUID = EXTERNAL_PLAYLIST_UUID
  runtime.playingData.playingSongListData = normalizedQueue
  runtime.playingData.playingSong = normalizedQueue[startIndex]
}

// 预加载
const audioPlayer = shallowRef<WebAudioPlayer | null>(null)
const AUDIO_FOLLOW_SYSTEM_ID = ''
let pendingAudioOutputDeviceId = runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
const waveformShow = ref(false)
const waveformContainerWidth = ref(0)
const updateParentWaveformWidth = () => {
  const waveformEl = waveform.value
  if (waveformEl && waveformShow.value && waveformEl.offsetParent !== null) {
    waveformContainerWidth.value = waveformEl.clientWidth
  } else {
    waveformContainerWidth.value = 0
  }
}

let previousTime = 0
const rangeStopTolerance = 0.05
let manualSeekActive = false
let manualSeekResetTimer: number | null = null
let teardownPlayerEvents: (() => void) | null = null

const clearManualSeekTimer = () => {
  if (manualSeekResetTimer !== null) {
    window.clearTimeout(manualSeekResetTimer)
    manualSeekResetTimer = null
  }
}

const scheduleManualSeekReset = () => {
  clearManualSeekTimer()
  manualSeekResetTimer = window.setTimeout(() => {
    manualSeekActive = false
    manualSeekResetTimer = null
  }, 400)
}

const bindPlayerEvents = (player: WebAudioPlayer) => {
  const disposers: Array<() => void> = []

  const onPlay = () => {
    playerControlsRef.value?.setPlayingValue?.(true)
    cancelPreloadTimer()
    schedulePreloadAfterPlay()
    runtime.playerReady = true
    runtime.isSwitchingSong = false
    previousTime = player.getCurrentTime()
  }
  player.on('play', onPlay)
  disposers.push(() => player.off('play', onPlay))

  const onPause = () => {
    cancelPreloadTimer()
    playerControlsRef.value?.setPlayingValue?.(false)
  }
  player.on('pause', onPause)
  disposers.push(() => player.off('pause', onPause))

  const onFinish = () => {
    cancelPreloadTimer()
    if (runtime.setting.autoPlayNextSong) {
      playerActions.nextSong()
    }
  }
  player.on('finish', onFinish)
  disposers.push(() => player.off('finish', onFinish))

  const onTimeUpdate = (currentTime: number) => {
    const timeEl = document.querySelector('#time')
    const durationEl = document.querySelector('#duration')
    if (!timeEl || !durationEl) return

    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    ;(timeEl as HTMLElement).textContent = formatTime(currentTime)

    if (runtime.setting.enablePlaybackRange) {
      const duration = player.getDuration()
      if (duration > 0) {
        const endPercent = runtime.setting.endPlayPercent ?? 100
        const endTime = (duration * endPercent) / 100
        const effectiveEnd = Math.max(endTime - rangeStopTolerance, 0)
        const crossedEnd =
          currentTime >= effectiveEnd && previousTime < effectiveEnd && player.isPlaying()
        if (crossedEnd) {
          if (manualSeekActive) {
            manualSeekActive = false
            clearManualSeekTimer()
          } else if (runtime.setting.autoPlayNextSong) {
            playerActions.nextSong()
          } else {
            player.pause()
          }
        }
      }
    }
    previousTime = currentTime
  }
  player.on('timeupdate', onTimeUpdate)
  disposers.push(() => player.off('timeupdate', onTimeUpdate))

  const onSeeked = ({ time, manual }: { time: number; manual: boolean }) => {
    previousTime = time
    if (manual) {
      manualSeekActive = true
      scheduleManualSeekReset()
    } else {
      manualSeekActive = false
      clearManualSeekTimer()
    }
  }
  player.on('seeked', onSeeked)
  disposers.push(() => player.off('seeked', onSeeked))

  const onDecode = (duration: number) => {
    const durationEl = document.querySelector('#duration')
    if (durationEl) {
      const formatTime = (seconds: number) => {
        const minutes = Math.floor(seconds / 60)
        const secondsRemainder = Math.round(seconds) % 60
        const paddedSeconds = `0${secondsRemainder}`.slice(-2)
        return `${minutes}:${paddedSeconds}`
      }
      durationEl.textContent = formatTime(duration)
      updateParentWaveformWidth()
    }
  }
  player.on('decode', onDecode)
  disposers.push(() => player.off('decode', onDecode))

  const onReady = () => {
    updateParentWaveformWidth()
  }
  player.on('ready', onReady)
  disposers.push(() => player.off('ready', onReady))

  const onError = async (error: any) => {
    const currentPath = runtime.playingData.playingSong?.filePath ?? null
    await handleSongLoadError(currentPath, false)
  }
  player.on('error', onError)
  disposers.push(() => player.off('error', onError))

  return () => {
    disposers.forEach((dispose) => {
      try {
        dispose()
      } catch {}
    })
  }
}

const initAudioPlayer = () => {
  if (teardownPlayerEvents) {
    teardownPlayerEvents()
    teardownPlayerEvents = null
  }
  if (audioPlayer.value) {
    audioPlayer.value.destroy()
  }
  const player = new WebAudioPlayer()
  audioPlayer.value = player
  teardownPlayerEvents = bindPlayerEvents(player)
  void applyAudioOutputDevice(pendingAudioOutputDeviceId)
}

// 封面与右键保存
const {
  coverBlobUrl,
  songInfoShow,
  handleSongInfoMouseLeave,
  showCoverContextMenu,
  setCoverByIPC
} = useCover(runtime)

// 预加载
const {
  schedulePreloadAfterPlay,
  cancelPreloadTimer,
  refreshPreloadWindow,
  clearNextCaches,
  clearAllCaches,
  takePreloadedData,
  rememberPlayback,
  forgetCachesForFile
} = usePreloadNextSong({ runtime })

// 加载/播放与错误处理
const bpm = ref<number | string>('')
const { isLoadingBlob, ignoreNextEmptyError, requestLoadSong, handleSongLoadError } = useSongLoader(
  {
    runtime,
    audioPlayer,
    bpm,
    waveformShow,
    setCoverByIPC,
    onSongBuffered: rememberPlayback
  }
)

const requestSongWithRecreate = (
  filePath: string,
  options?: { preloadedAudio?: HTMLAudioElement | null; preloadedBpm?: number | string | null }
) => {
  requestLoadSong(filePath, options)
}

// 内部切歌标志
const isInternalSongChange = ref(false)

const handleReplayRequest = () => {
  const playerInstance = audioPlayer.value
  if (!playerInstance) return
  if (!runtime.playingData.playingSong) return

  const duration = playerInstance.getDuration()
  if (!duration || Number.isNaN(duration)) return

  const enableRange = runtime.setting.enablePlaybackRange
  const startPercentRaw = enableRange ? (runtime.setting.startPlayPercent ?? 0) : 0
  const startPercentNumber =
    typeof startPercentRaw === 'number' ? startPercentRaw : parseFloat(String(startPercentRaw))
  const safePercent = Number.isFinite(startPercentNumber) ? startPercentNumber : 0
  const clampedPercent = Math.min(Math.max(safePercent, 0), 100)
  const startTime = (duration * clampedPercent) / 100

  const wasPlaying = playerInstance.isPlaying()
  runtime.playerReady = false

  playerInstance.seek(startTime)
  if (!wasPlaying) {
    playerInstance.play(startTime)
  }
}

// 初始化 WebAudioPlayer 和波形
onMounted(() => {
  initAudioPlayer()
  emitter.on('player/replay-current-song', handleReplayRequest)
  emitter.on('external-open/play', handleExternalOpenPlay)
  emitter.on('waveform-preview:pause-main', handleWaveformPreviewPauseMain)
  emitter.on('waveform-preview:resume-main', handleWaveformPreviewResumeMain)

  useWaveform({
    waveformEl: waveform,
    audioPlayer,
    runtime,
    updateParentWaveformWidth,
    onNextSong: () => playerActions.nextSong(),
    schedulePreloadAfterPlay,
    cancelPreloadTimer,
    playerControlsRef,
    onError: async (error: any) => {
      const currentPath = runtime.playingData.playingSong?.filePath ?? null
      await handleSongLoadError(currentPath, false)
    }
  })

  try {
    const s = localStorage.getItem('frkb_volume')
    let v = s !== null ? parseFloat(s) : NaN
    if (!(v >= 0 && v <= 1)) v = 0.8
    audioPlayer.value?.setVolume(v)
  } catch (_) {}

  window.addEventListener('resize', updateParentWaveformWidth)
  window.electron.ipcRenderer.on('player/global-shortcut', handleGlobalPlayerShortcut)
})

// 歌曲移动、删除、播放控制等统一动作
const selectSongListDialogLibraryName = ref('FilterLibrary')
const selectSongListDialogShow = ref(false)
const playerActions = usePlayerControlsLogic({
  audioPlayer,
  runtime,
  bpm,
  waveformShow,
  selectSongListDialogShow,
  selectSongListDialogLibraryName,
  isInternalSongChange,
  requestLoadSong: requestSongWithRecreate,
  cancelPreloadTimer,
  ignoreNextEmptyError,
  preloadApi: {
    takePreloadedData,
    refreshPreloadWindow,
    clearNextCaches,
    clearAllCaches,
    rememberPlayback,
    forgetCachesForFile
  }
})

const handleWaveformPreviewPauseMain = (payload?: { onPaused?: (wasPlaying: boolean) => void }) => {
  const wasPlaying = audioPlayer.value?.isPlaying() ?? false
  if (wasPlaying) {
    audioPlayer.value?.pause()
  }
  payload?.onPaused?.(wasPlaying)
}

const handleWaveformPreviewResumeMain = () => {
  playerActions.play()
}

const stopWaveformPreviewForManualPlay = () => {
  try {
    emitter.emit('waveform-preview:stop', { reason: 'manual-play' })
  } catch {}
}

const handleUserPlay = () => {
  stopWaveformPreviewForManualPlay()
  playerActions.play()
}

const handleUserNextSong = () => {
  stopWaveformPreviewForManualPlay()
  playerActions.nextSong()
}

const handleUserPreviousSong = () => {
  stopWaveformPreviewForManualPlay()
  playerActions.previousSong()
}

const handleUserTogglePlayPause = () => {
  const isPlaying = audioPlayer.value?.isPlaying() ?? false
  if (!isPlaying) {
    stopWaveformPreviewForManualPlay()
  }
  playerActions.togglePlayPause()
}

const selectSongListDialogConfirm = async (item: string) => {
  await playerActions.handleMoveSong(item)
}

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const applyAudioOutputDevice = async (deviceId: string) => {
  pendingAudioOutputDeviceId = deviceId
  const playerInstance = audioPlayer.value
  if (!playerInstance) {
    return
  }
  try {
    await playerInstance.setOutputDevice(deviceId)
  } catch (error) {
    console.warn('[player] 切换输出设备失败，已回退默认输出', error)
    if (deviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
      pendingAudioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
      if (runtime.setting.audioOutputDeviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
        runtime.setting.audioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
        await setSetting()
      }
      try {
        await playerInstance.setOutputDevice(AUDIO_FOLLOW_SYSTEM_ID)
      } catch (_) {
        // 回退默认输出失败时无需额外处理
      }
    }
  }
}

// 热键
const hotkeyActions = {
  play: handleUserPlay,
  pause: playerActions.pause,
  fastForward: playerActions.fastForward,
  fastBackward: playerActions.fastBackward,
  nextSong: handleUserNextSong,
  previousSong: handleUserPreviousSong,
  delSong: playerActions.delSong,
  moveToListLibrary: playerActions.moveToListLibrary,
  moveToLikeLibrary: playerActions.moveToLikeLibrary,
  togglePlayPause: handleUserTogglePlayPause
}

const isPlaying = computed(() => audioPlayer.value?.isPlaying() ?? false)
const playerState = {
  waveformShow,
  selectSongListDialogShow,
  confirmShow: readonly(toRef(runtime, 'confirmShow')),
  songsAreaSelectedCount: computed(() => runtime.songsArea.selectedSongFilePath.length),
  activeMenuUUID: toRef(runtime, 'activeMenuUUID'),
  isPlaying: readonly(isPlaying)
}
usePlayerHotkeys(hotkeyActions, playerState, runtime)

type GlobalPlayerShortcutAction = 'fastForward' | 'fastBackward' | 'nextSong' | 'previousSong'
const handleGlobalPlayerShortcut = (
  _event: IpcRendererEvent,
  action: GlobalPlayerShortcutAction
) => {
  if (!waveformShow.value) {
    return
  }
  if ((action === 'nextSong' || action === 'previousSong') && selectSongListDialogShow.value) {
    return
  }
  switch (action) {
    case 'fastForward':
      playerActions.fastForward()
      break
    case 'fastBackward':
      playerActions.fastBackward()
      break
    case 'nextSong':
      handleUserNextSong()
      break
    case 'previousSong':
      handleUserPreviousSong()
      break
  }
}

watch(
  () => runtime.setting.audioOutputDeviceId,
  (newValue) => {
    const nextId = newValue || AUDIO_FOLLOW_SYSTEM_ID
    void applyAudioOutputDevice(nextId)
  },
  { immediate: true }
)

// 初始化与销毁

onUnmounted(() => {
  cancelPreloadTimer()
  runtime.playerReady = false
  clearManualSeekTimer()
  if (teardownPlayerEvents) {
    teardownPlayerEvents()
    teardownPlayerEvents = null
  }
  if (audioPlayer.value) {
    audioPlayer.value.destroy()
    audioPlayer.value = null
  }
  window.removeEventListener('resize', updateParentWaveformWidth)
  emitter.off('player/replay-current-song', handleReplayRequest)
  emitter.off('external-open/play', handleExternalOpenPlay)
  emitter.off('waveform-preview:pause-main', handleWaveformPreviewPauseMain)
  emitter.off('waveform-preview:resume-main', handleWaveformPreviewResumeMain)
  window.electron.ipcRenderer.removeListener('player/global-shortcut', handleGlobalPlayerShortcut)
})

// 切歌响应（含预加载命中）
watch(
  () => runtime.playingData.playingSong,
  (newSong, oldSong) => {
    if (newSong?.filePath && newSong.filePath !== oldSong?.filePath) {
      try {
        window.electron.ipcRenderer.send('key-analysis:queue-playing', {
          filePath: newSong.filePath
        })
      } catch {}
    }
    if (isInternalSongChange.value) {
      isInternalSongChange.value = false
      return
    }

    if (newSong === null) {
      cancelPreloadTimer()
      clearAllCaches()
      if (audioPlayer.value) {
        ignoreNextEmptyError.value = true
        audioPlayer.value.empty()
      }
      waveformShow.value = false
      runtime.playingData.playingSongListUUID = ''
      bpm.value = ''
    } else if (newSong?.filePath !== oldSong?.filePath) {
      const newPath = newSong.filePath
      setCoverByIPC(newPath)
      const preloadHit = takePreloadedData(newPath)
      if (preloadHit) {
        requestSongWithRecreate(newPath, {
          preloadedAudio: preloadHit.audio,
          preloadedBpm: preloadHit.bpm ?? undefined
        })
      } else {
        cancelPreloadTimer()
        clearNextCaches()
        requestSongWithRecreate(newPath)
      }
      refreshPreloadWindow()
    } else if (newSong && oldSong && newSong !== oldSong && newSong.filePath === oldSong.filePath) {
      setCoverByIPC(newSong.filePath)
    }
  }
)

watch(
  () => runtime.playingData.playingSong?.bpm,
  (newBpm) => {
    if (typeof newBpm === 'number' && Number.isFinite(newBpm) && newBpm > 0) {
      bpm.value = newBpm
    }
  }
)

// 控件区域展开/收起后宽度刷新
watch(
  () => runtime.setting.hiddenPlayControlArea,
  async (newValue, oldValue) => {
    if (newValue !== oldValue && waveformShow.value && audioPlayer.value) {
      await nextTick()
      updateParentWaveformWidth()
    }
  }
)
</script>
<template>
  <transition name="player-area-toggle">
    <div
      v-show="waveformShow"
      class="playerArea"
      style="
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        padding: 0 5px 0 0;
        box-sizing: border-box;
      "
    >
      <div style="width: 50px; display: flex" class="unselectable">
        <div
          style="
            display: flex;
            justify-content: center;
            align-items: center;
            height: 50px;
            width: 50px;
          "
          @mouseenter="songInfoShow = true"
        >
          <transition name="cover-switch" mode="out-in">
            <img v-if="coverBlobUrl" :key="coverBlobUrl" :src="coverBlobUrl" class="songCover" />
            <img v-else :key="'placeholder'" :src="musicIcon" style="width: 25px; height: 25px" />
          </transition>
        </div>
      </div>
      <transition name="fade">
        <div v-if="songInfoShow" @mouseleave="handleSongInfoMouseLeave" class="songInfo">
          <div class="cover unselectable" @contextmenu.prevent="showCoverContextMenu">
            <img
              v-if="coverBlobUrl"
              :src="coverBlobUrl"
              style="width: 280px; height: 280px"
              draggable="false"
            />
            <img v-else :src="musicIcon" style="width: 48px; height: 48px" draggable="false" />
          </div>
          <div style="font-size: 14px" class="info">
            {{ runtime.playingData.playingSong?.title }}
          </div>
          <div style="font-size: 12px" class="info">
            {{ runtime.playingData.playingSong?.artist }}
          </div>
          <div style="font-size: 10px" class="info">
            {{ runtime.playingData.playingSong?.album }}
          </div>
          <div style="font-size: 10px" class="info">
            {{ runtime.playingData.playingSong?.label }}
          </div>
        </div>
      </transition>
      <div
        class="controlsContainer"
        :style="{ width: runtime.setting.hiddenPlayControlArea ? '15px' : '260px' }"
      >
        <transition name="player-controls-toggle">
          <playerControls
            v-if="!runtime.setting.hiddenPlayControlArea"
            ref="playerControlsRef"
            @pause="playerActions.pause"
            @play="handleUserPlay"
            @fastForward="playerActions.fastForward"
            @fastBackward="playerActions.fastBackward"
            @nextSong="handleUserNextSong"
            @previousSong="handleUserPreviousSong"
            @delSong="playerActions.delSong"
            @moveToListLibrary="(song) => playerActions.moveToListLibrary(song)"
            @moveToLikeLibrary="(song) => playerActions.moveToLikeLibrary(song)"
            @exportTrack="playerActions.exportTrack"
            @setVolume="
              (v) => {
                try {
                  audioPlayer?.setVolume?.(v)
                } catch (_) {}
              }
            "
          />
        </transition>
      </div>

      <div style="flex-grow: 1; position: relative" class="unselectable">
        <div id="waveform" ref="waveform">
          <div id="time">0:00</div>
          <div id="duration">0:00</div>
          <div id="hover"></div>
        </div>

        <PlaybackRangeHandles
          v-model:modelValueStart="runtime.setting.startPlayPercent"
          v-model:modelValueEnd="runtime.setting.endPlayPercent"
          :container-width="waveformContainerWidth"
          :enable-playback-range="runtime.setting.enablePlaybackRange"
          :waveform-show="waveformShow"
          @dragEnd="setSetting"
        />
      </div>
      <BpmTap
        :bpm="bpm"
        :waveformShow="waveformShow"
        :keyText="runtime.playingData.playingSong?.key || ''"
      />
    </div>
  </transition>
  <selectSongListDialog
    v-if="selectSongListDialogShow"
    :libraryName="selectSongListDialogLibraryName"
    @confirm="selectSongListDialogConfirm"
    @cancel="
      () => {
        selectSongListDialogShow = false
      }
    "
  />
</template>
<style lang="scss" scoped>
.songInfo {
  width: 300px;
  height: 370px;
  background-color: var(--bg-elev);
  position: absolute;
  bottom: 25px;
  left: 50px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding-top: 10px;
  z-index: 10010;
  color: var(--text);

  .cover {
    width: 100%;
    height: 280px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .info {
    width: 100%;
    padding: 5px 10px 0;
    box-sizing: border-box;
    white-space: nowrap;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}

#waveform {
  position: relative;
  min-height: 40px;
}

.songCover {
  width: 40px;
  height: 40px;
}

#hover {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 10;
  pointer-events: none;
  height: 100%;
  width: 0;
  mix-blend-mode: overlay;
  background: rgba(255, 255, 255, 0.5);
  opacity: 0;
  transition: opacity 0.2s ease;
}

#waveform:hover #hover {
  opacity: 1;
}

#time,
#duration {
  position: absolute;
  z-index: 11;
  top: 50%;
  margin-top: -1px;
  transform: translateY(-50%);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.75);
  padding: 2px;
  color: #ddd;
}

#time {
  left: 0;
}

#duration {
  right: 0;
}

.player-area-toggle-enter-active,
.player-area-toggle-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.player-area-toggle-enter-from,
.player-area-toggle-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.controlsContainer {
  transition: width 0.22s ease;
  /* 允许音量条、更多菜单浮层溢出容器 */
  overflow: visible;
}

.player-controls-toggle-enter-active,
.player-controls-toggle-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.player-controls-toggle-enter-from,
.player-controls-toggle-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.cover-switch-enter-active,
.cover-switch-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.cover-switch-enter-from,
.cover-switch-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

@media (prefers-reduced-motion: reduce) {
  .player-area-toggle-enter-active,
  .player-area-toggle-leave-active,
  .player-controls-toggle-enter-active,
  .player-controls-toggle-leave-active,
  .controlsContainer,
  .cover-switch-enter-active,
  .cover-switch-leave-active {
    transition: none;
  }
}
</style>
