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
import type WaveSurfer from 'wavesurfer.js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIcon from '@renderer/assets/musicIcon.png?asset'
import playerControls from '../../../components/playerControls.vue'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import BpmTap from './BpmTap.vue'
import PlaybackRangeHandles from './PlaybackRangeHandles.vue'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import { usePlayerControlsLogic } from './usePlayerControlsLogic'
import { useCover } from './useCover'
import { usePreloadNextSong } from './usePreloadNextSong'
import { useSongLoader } from './useSongLoader'
import { useWaveSurfer } from './useWaveSurfer'

const runtime = useRuntimeStore()
const waveform = useTemplateRef<HTMLDivElement>('waveform')
const playerControlsRef = useTemplateRef('playerControlsRef')

const wavesurferInstance = shallowRef<WaveSurfer | null>(null)
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

// 封面与右键保存
const {
  coverBlobUrl,
  songInfoShow,
  handleSongInfoMouseLeave,
  showCoverContextMenu,
  setCoverByIPC
} = useCover(runtime)

// 预加载与 BPM 预计算
const audioContext = new AudioContext()
const {
  isPreloading,
  isPreloadReady,
  preloadedBlob,
  preloadedSongFilePath,
  preloadedBpm,
  currentPreloadRequestId,
  cancelPreloadTimer,
  clearReadyPreloadState,
  schedulePreloadAfterPlay,
  preloadNextSong
} = usePreloadNextSong({ runtime, audioContext })

// 加载/播放与错误处理
const bpm = ref<number | string>('')
const {
  currentLoadRequestId,
  isLoadingBlob,
  ignoreNextEmptyError,
  requestLoadSong,
  handleLoadBlob,
  handleSongLoadError
} = useSongLoader({
  runtime,
  wavesurferInstance,
  audioContext,
  bpm,
  waveformShow,
  setCoverByIPC
})

// 内部切歌标志
const isInternalSongChange = ref(false)

// WaveSurfer 实例与事件
useWaveSurfer({
  runtime,
  waveformEl: waveform,
  wavesurferInstance,
  updateParentWaveformWidth,
  onNextSong: () => playerActions.nextSong(),
  schedulePreloadAfterPlay,
  cancelPreloadTimer,
  playerControlsRef,
  onError: async (error: any) => {
    const errorCode = error?.code
    if (errorCode === 4 && ignoreNextEmptyError.value) {
      ignoreNextEmptyError.value = false
      return
    }
    const currentPath = runtime.playingData.playingSong?.filePath ?? null
    if (errorCode !== 4) {
      await handleSongLoadError(currentPath, false)
    }
  }
})

// 歌曲移动、删除、播放控制等统一动作
const selectSongListDialogLibraryName = ref('FilterLibrary')
const selectSongListDialogShow = ref(false)
const playerActions = usePlayerControlsLogic({
  wavesurferInstance,
  runtime,
  bpm,
  waveformShow,
  selectSongListDialogShow,
  selectSongListDialogLibraryName,
  isInternalSongChange,
  requestLoadSong,
  handleLoadBlob,
  cancelPreloadTimer,
  currentLoadRequestId,
  preloadedBlob,
  preloadedSongFilePath,
  preloadedBpm,
  isPreloading,
  isPreloadReady,
  ignoreNextEmptyError,
  clearReadyPreloadState
})

const selectSongListDialogConfirm = async (item: string) => {
  await playerActions.handleMoveSong(item)
}

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

// 热键
const hotkeyActions = {
  play: playerActions.play,
  pause: playerActions.pause,
  fastForward: playerActions.fastForward,
  fastBackward: playerActions.fastBackward,
  nextSong: playerActions.nextSong,
  previousSong: playerActions.previousSong,
  delSong: playerActions.delSong,
  moveToListLibrary: playerActions.moveToListLibrary,
  moveToLikeLibrary: playerActions.moveToLikeLibrary,
  togglePlayPause: playerActions.togglePlayPause
}

const isPlaying = computed(() => wavesurferInstance.value?.isPlaying() ?? false)
const playerState = {
  waveformShow,
  selectSongListDialogShow,
  confirmShow: readonly(toRef(runtime, 'confirmShow')),
  songsAreaSelectedCount: computed(() => runtime.songsArea.selectedSongFilePath.length),
  activeMenuUUID: toRef(runtime, 'activeMenuUUID'),
  isPlaying: readonly(isPlaying)
}
usePlayerHotkeys(hotkeyActions, playerState, runtime)

// 初始化与销毁
onMounted(() => {
  // 应用持久化音量（默认 0.8）
  try {
    const s = localStorage.getItem('frkb_volume')
    let v = s !== null ? parseFloat(s) : NaN
    if (!(v >= 0 && v <= 1)) v = 0.8
    wavesurferInstance.value?.setVolume?.(v)
  } catch (_) {}
  window.addEventListener('resize', updateParentWaveformWidth)
})

onUnmounted(() => {
  cancelPreloadTimer()
  runtime.playerReady = false
  window.removeEventListener('resize', updateParentWaveformWidth)
})

// 切歌响应（含预加载命中）
watch(
  () => runtime.playingData.playingSong,
  (newSong, oldSong) => {
    if (isInternalSongChange.value) {
      isInternalSongChange.value = false
      return
    }

    if (newSong === null) {
      cancelPreloadTimer()
      clearReadyPreloadState()
      if (wavesurferInstance.value) {
        ignoreNextEmptyError.value = true
        wavesurferInstance.value.empty()
      }
      waveformShow.value = false
      runtime.playingData.playingSongListUUID = ''
      bpm.value = ''
    } else if (newSong?.filePath !== oldSong?.filePath) {
      const newPath = newSong.filePath
      setCoverByIPC(newPath)
      if (isPreloadReady.value && newPath === preloadedSongFilePath.value && preloadedBlob.value) {
        const blobToLoad = preloadedBlob.value
        const bpmValueToUse = preloadedBpm.value
        clearReadyPreloadState()
        currentLoadRequestId.value++
        handleLoadBlob(blobToLoad, newPath, currentLoadRequestId.value, bpmValueToUse)
      } else {
        cancelPreloadTimer()
        clearReadyPreloadState()
        requestLoadSong(newPath)
      }
    }
  }
)

// 控件区域展开/收起后宽度刷新
watch(
  () => runtime.setting.hiddenPlayControlArea,
  async (newValue, oldValue) => {
    if (newValue !== oldValue && waveformShow.value && wavesurferInstance.value) {
      await nextTick()
      updateParentWaveformWidth()
    }
  }
)
</script>
<template>
  <div
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
        v-show="waveformShow"
        style="
          display: flex;
          justify-content: center;
          align-items: center;
          height: 50px;
          width: 50px;
        "
        @mouseenter="songInfoShow = true"
      >
        <img v-if="coverBlobUrl" :src="coverBlobUrl" class="songCover" />
        <img v-else :src="musicIcon" style="width: 25px; height: 25px" />
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
      :style="{ width: runtime.setting.hiddenPlayControlArea ? '15px' : '260px' }"
      v-show="waveformShow"
    >
      <playerControls
        v-if="!runtime.setting.hiddenPlayControlArea"
        ref="playerControlsRef"
        @pause="playerActions.pause"
        @play="playerActions.play"
        @fastForward="playerActions.fastForward"
        @fastBackward="playerActions.fastBackward"
        @nextSong="playerActions.nextSong"
        @previousSong="playerActions.previousSong"
        @delSong="playerActions.delSong"
        @moveToListLibrary="(song) => playerActions.moveToListLibrary(song)"
        @moveToLikeLibrary="(song) => playerActions.moveToLikeLibrary(song)"
        @exportTrack="playerActions.exportTrack"
        @setVolume="
          (v) => {
            try {
              wavesurferInstance?.setVolume?.(v)
            } catch (_) {}
          }
        "
      />
    </div>

    <div style="flex-grow: 1; position: relative" class="unselectable">
      <div id="waveform" ref="waveform" v-show="waveformShow">
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
    <BpmTap :bpm="bpm" :waveformShow="waveformShow" />
  </div>
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
  background-color: #202020;
  position: absolute;
  bottom: 25px;
  left: 50px;
  border: 1px solid #424242;
  border-radius: 3px;
  padding-top: 10px;
  z-index: 99;

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
</style>
