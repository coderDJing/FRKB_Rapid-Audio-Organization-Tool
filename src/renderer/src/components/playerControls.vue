<script setup lang="ts">
import previousSongAsset from '@renderer/assets/previousSong.svg?asset'
import fastBackwardAsset from '@renderer/assets/fastBackward.svg?asset'
import playAsset from '@renderer/assets/play.svg?asset'
import pauseAsset from '@renderer/assets/pause.svg?asset'
import fastForwardAsset from '@renderer/assets/fastForward.svg?asset'
import nextSongAsset from '@renderer/assets/nextSong.svg?asset'
import moreAsset from '@renderer/assets/more.svg?asset'
import volumePngAsset from '@renderer/assets/volume.svg?asset'
import volumeMutePngAsset from '@renderer/assets/volumeMute.svg?asset'
import { ref, onUnmounted, watch, useTemplateRef, onMounted, computed } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import shortcutIconAsset from '@renderer/assets/shortcutIcon.svg?asset'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
const previousSong = previousSongAsset
const fastBackward = fastBackwardAsset
const play = playAsset
const pause = pauseAsset
const fastForward = fastForwardAsset
const nextSong = nextSongAsset
const more = moreAsset
const volumePng = volumePngAsset
const volumeMutePng = volumeMutePngAsset
const shortcutIcon = shortcutIconAsset
const uuid = uuidV4()
const runtime = useRuntimeStore()
const playing = ref(true)
watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      moreMenuShow.value = false
    }
  }
)
const emits = defineEmits([
  'pause',
  'play',
  'fastForward',
  'fastBackward',
  'nextSong',
  'previousSong',
  'delSong',
  'moveToLikeLibrary',
  'moveToListLibrary',
  'exportTrack',
  'setVolume'
])

const setPlayingValue = (value: boolean) => {
  playing.value = value
}

const handlePause = () => {
  playing.value = !playing.value
  emits('pause')
}

const handlePlay = () => {
  playing.value = !playing.value
  emits('play')
}

let fastForwardInterval: NodeJS.Timeout
const handleFastForwardMouseup = () => {
  clearInterval(fastForwardInterval)
  document.removeEventListener('mouseup', handleFastForwardMouseup)
}
const handleFastForward = () => {
  emits('fastForward')
  fastForwardInterval = setInterval(() => {
    emits('fastForward')
  }, 200)
  document.addEventListener('mouseup', handleFastForwardMouseup)
}

let fastBackwardInterval: NodeJS.Timeout
const handleFastBackwardMouseup = () => {
  clearInterval(fastBackwardInterval)
  document.removeEventListener('mouseup', handleFastBackwardMouseup)
}
const handleFastBackward = () => {
  emits('fastBackward')
  fastBackwardInterval = setInterval(() => {
    emits('fastBackward')
  }, 200)
  document.addEventListener('mouseup', handleFastBackwardMouseup)
}

const handleNextSong = () => {
  emits('nextSong')
}

const handlePreviousSong = () => {
  emits('previousSong')
}

onUnmounted(() => {
  document.removeEventListener('mouseup', handleFastForwardMouseup)
  document.removeEventListener('mouseup', handleFastBackwardMouseup)
})

defineExpose({
  setPlayingValue
})

const moreMenuShow = ref(false)
const handelMoreClick = () => {
  if (moreMenuShow.value) {
    runtime.activeMenuUUID = ''
    moreMenuShow.value = false
    return
  }
  runtime.activeMenuUUID = uuid
  moreMenuShow.value = true
}

const previousSongRef = useTemplateRef('previousSongRef')
const fastBackwardRef = useTemplateRef('fastBackwardRef')
const playRef = useTemplateRef('playRef')
const pauseRef = useTemplateRef('pauseRef')
const fastForwardRef = useTemplateRef('fastForwardRef')
const nextSongRef = useTemplateRef('nextSongRef')

const delSong = () => {
  emits('delSong')
}

const moveToLikeLibrary = () => {
  emits('moveToLikeLibrary', runtime.playingData.playingSong)
}

const moveToListLibrary = () => {
  emits('moveToListLibrary', runtime.playingData.playingSong)
}
const exportTrack = () => {
  emits('exportTrack')
}
const showInFileExplorer = () => {
  window.electron.ipcRenderer.send('show-item-in-folder', runtime.playingData.playingSong?.filePath)
}

const handleAnalyzeCurrentSongFingerprint = async () => {
  const filePath = runtime.playingData.playingSong?.filePath
  if (!filePath) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('fingerprints.noPlayingTrack')],
      confirmShow: false
    })
    return
  }
  await analyzeFingerprintsForPaths([filePath], { origin: 'player' })
  runtime.activeMenuUUID = ''
  moreMenuShow.value = false
}

// ---------------- 音量控制 ----------------
const VOLUME_KEY = 'frkb_volume'
const volume = ref(1)
const lastNonZeroVolume = ref(1)
const sliderHovering = ref(false)
const iconHovering = ref(false)
let draggingVolume = false
const showVolumeSlider = computed(
  () => iconHovering.value || sliderHovering.value || draggingVolume
)

const volumeIcon = computed(() => {
  return volume.value <= 0 ? volumeMutePng : volumePng
})

const emitSetVolume = (val: number) => {
  const v = Math.min(1, Math.max(0, val))
  volume.value = v
  if (v > 0) lastNonZeroVolume.value = v
  emits('setVolume', v)
  try {
    localStorage.setItem(VOLUME_KEY, String(v))
  } catch (_) {}
}

let justDragged = false
const toggleMute = () => {
  // 仅在拖动中或刚拖完的极短时间内抑制，其他情况立即切换
  if (draggingVolume || justDragged) return
  if (volume.value > 0) {
    lastNonZeroVolume.value = volume.value
    emitSetVolume(0)
  } else {
    const prev = Number.isFinite(lastNonZeroVolume.value as number)
      ? (lastNonZeroVolume.value as number)
      : 0
    // 若历史非零音量过低(<10%)，按 10% 恢复，避免“体感几乎为 0”
    const restore = prev > 0 ? Math.max(prev, 0.1) : 0.25
    emitSetVolume(restore)
  }
}

const volumeBarRef = useTemplateRef<HTMLDivElement>('volumeBarRef')
const updateVolumeFromClientY = (clientY: number) => {
  const el = volumeBarRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (!rect || rect.height <= 0) return
  const ratio = 1 - (clientY - rect.top) / rect.height
  emitSetVolume(ratio)
}

const handleBarMousedown = (e: MouseEvent) => {
  draggingVolume = true
  updateVolumeFromClientY(e.clientY)
  document.addEventListener('mousemove', handleBarMousemove)
  document.addEventListener('mouseup', handleBarMouseup)
}
const handleBarMousemove = (e: MouseEvent) => {
  if (!draggingVolume) return
  updateVolumeFromClientY(e.clientY)
}
const handleBarMouseup = () => {
  draggingVolume = false
  justDragged = true
  setTimeout(() => {
    justDragged = false
  }, 150)
  document.removeEventListener('mousemove', handleBarMousemove)
  document.removeEventListener('mouseup', handleBarMouseup)
}

onUnmounted(() => {
  document.removeEventListener('mousemove', handleBarMousemove)
  document.removeEventListener('mouseup', handleBarMouseup)
})

// 初始化从 localStorage 读取音量（默认 0.8）并应用
onMounted(() => {
  try {
    const s = localStorage.getItem(VOLUME_KEY)
    let v = s !== null ? parseFloat(s) : NaN
    if (!(v >= 0 && v <= 1)) v = 0.8
    // 设置组件内部状态并通知父组件
    volume.value = v
    lastNonZeroVolume.value = v > 0 ? v : 0
    emits('setVolume', v)
  } catch (_) {}
})

// ---------------- 系统媒体会话（Media Session API）集成 ----------------
// 目标：启用系统的 上一首/下一首/播放/暂停 按钮，并同步元数据和播放状态
let artworkUrl: string = ''

const hasPrev = computed(() => {
  const list = runtime.playingData.playingSongListData
  const cur = runtime.playingData.playingSong?.filePath
  if (!cur) return false
  const idx = list.findIndex((i) => i.filePath === cur)
  return idx > 0
})

const hasNext = computed(() => {
  const list = runtime.playingData.playingSongListData
  const cur = runtime.playingData.playingSong?.filePath
  if (!cur) return false
  const idx = list.findIndex((i) => i.filePath === cur)
  return idx !== -1 && idx < list.length - 1
})

const revokeArtworkUrl = () => {
  if (artworkUrl) {
    try {
      URL.revokeObjectURL(artworkUrl)
    } catch (_) {
      /* ignore */
    }
    artworkUrl = ''
  }
}

const updateMediaSessionMetadata = () => {
  // 有些平台不支持 Media Session
  // @ts-ignore
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const song = runtime.playingData.playingSong
  // @ts-ignore
  const mediaSession = navigator.mediaSession as MediaSession

  revokeArtworkUrl()

  let artwork: Array<{ src: string; sizes?: string; type?: string }> | undefined
  try {
    if (song?.cover?.data && song?.cover?.format) {
      const blob = new Blob([Uint8Array.from(song.cover.data)], { type: song.cover.format })
      artworkUrl = URL.createObjectURL(blob)
      artwork = [
        {
          src: artworkUrl,
          sizes: '512x512',
          type: song.cover.format
        }
      ]
    }
  } catch (_) {
    // 忽略封面生成异常
  }

  // @ts-ignore
  mediaSession.metadata = new window.MediaMetadata({
    title: song?.title || t('tracks.unknownTrack'),
    artist: song?.artist || t('tracks.unknownArtist'),
    album: song?.album || '',
    artwork
  })
}

const updatePlaybackState = () => {
  // @ts-ignore
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  // @ts-ignore
  navigator.mediaSession.playbackState = playing.value ? 'playing' : 'paused'
}

const updateActionHandlers = () => {
  // @ts-ignore
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  // @ts-ignore
  const ms = navigator.mediaSession as MediaSession

  ms.setActionHandler('play', () => {
    if (!playing.value) emits('play')
  })
  ms.setActionHandler('pause', () => {
    if (playing.value) emits('pause')
  })

  ms.setActionHandler('previoustrack', hasPrev.value ? () => emits('previousSong') : null)
  ms.setActionHandler('nexttrack', hasNext.value ? () => emits('nextSong') : null)
}

onMounted(() => {
  updateMediaSessionMetadata()
  updatePlaybackState()
  updateActionHandlers()
})

watch(
  () => runtime.playingData.playingSong,
  () => {
    updateMediaSessionMetadata()
    updateActionHandlers()
  }
)

watch([hasPrev, hasNext], () => {
  updateActionHandlers()
})

watch(playing, () => {
  updatePlaybackState()
})

onUnmounted(() => {
  // @ts-ignore
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    // @ts-ignore
    const ms = navigator.mediaSession as MediaSession
    ms.setActionHandler('play', null)
    ms.setActionHandler('pause', null)
    ms.setActionHandler('previoustrack', null)
    ms.setActionHandler('nexttrack', null)
    // 清理元数据可选
    // @ts-ignore
    try {
      navigator.mediaSession.metadata = null as any
    } catch (_) {}
  }
  revokeArtworkUrl()
})
// ---------------- End 媒体会话集成 ----------------
</script>
<template>
  <div class="playerControlsRoot">
    <div
      class="playerControls unselectable"
      style="
        width: 100%;
        height: 50px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      "
    >
      <div ref="previousSongRef" class="buttonIcon" @click="handlePreviousSong()">
        <img :src="previousSong" draggable="false" />
      </div>
      <bubbleBox :dom="previousSongRef || undefined" :title="t('player.previous')" shortcut="W" />
      <div ref="fastBackwardRef" class="buttonIcon" @mousedown="handleFastBackward()">
        <img :src="fastBackward" draggable="false" />
      </div>
      <bubbleBox
        :dom="fastBackwardRef || undefined"
        :title="t('player.fastBackward')"
        shortcut="A"
      />
      <div ref="playRef" class="buttonIcon" v-show="!playing" @click="handlePlay()">
        <img :src="play" draggable="false" />
      </div>
      <bubbleBox :dom="playRef || undefined" :title="t('player.play')" shortcut="Space" />
      <div ref="pauseRef" class="buttonIcon" v-show="playing" @click="handlePause()">
        <img :src="pause" draggable="false" />
      </div>
      <bubbleBox :dom="pauseRef || undefined" :title="t('player.pause')" shortcut="Space" />
      <div ref="fastForwardRef" class="buttonIcon" @mousedown="handleFastForward()">
        <img :src="fastForward" draggable="false" />
      </div>
      <bubbleBox :dom="fastForwardRef || undefined" :title="t('player.fastForward')" shortcut="D" />
      <div ref="nextSongRef" class="buttonIcon" @click="handleNextSong()">
        <img :src="nextSong" draggable="false" />
      </div>
      <bubbleBox :dom="nextSongRef || undefined" :title="t('player.next')" shortcut="S" />
      <!-- 音量按钮，与“下一首”同风格 -->
      <div
        class="buttonIcon volumeIcon"
        @mouseenter="iconHovering = true"
        @mouseleave="iconHovering = false"
        style="position: relative"
      >
        <img :src="volumeIcon" draggable="false" @click.stop="toggleMute" />
        <transition name="fade">
          <div
            v-if="showVolumeSlider"
            class="volumePopover unselectable"
            @mouseenter="sliderHovering = true"
            @mouseleave="sliderHovering = false"
          >
            <div class="volumeBar" ref="volumeBarRef" @mousedown="handleBarMousedown">
              <div class="volumeFill" :style="{ height: Math.round(volume * 100) + '%' }"></div>
            </div>
          </div>
        </transition>
      </div>
      <div class="buttonIcon" @click.stop="handelMoreClick()">
        <img :src="more" draggable="false" />
      </div>
    </div>
    <transition name="fade">
      <div class="moreMenu unselectable" v-if="moreMenuShow">
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="exportTrack()">
            <span>{{ t('tracks.exportTracks') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="moveToListLibrary()">
            <div>
              <span>{{ t('library.moveToFilter') }}</span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>Q</span>
            </div>
          </div>
          <div class="menuButton" @click="moveToLikeLibrary()">
            <div>
              <span>{{ t('library.moveToCurated') }}</span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>E</span>
            </div>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="delSong()">
            <div>
              <span>{{ t('tracks.deleteTracks') }} </span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>F</span>
            </div>
          </div>
        </div>
        <div style="padding: 5px 5px">
          <div class="menuButton" @click="showInFileExplorer()">
            <span>{{ t('tracks.showInFileExplorer') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-top: 1px solid var(--border)">
          <div class="menuButton" @click="handleAnalyzeCurrentSongFingerprint()">
            <span>{{ t('fingerprints.analyzeAndAdd') }}</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
<style lang="scss" scoped>
.moreMenu {
  width: 250px;
  background-color: var(--bg-elev);
  position: absolute;
  border: 1px solid var(--border);
  border-radius: 3px;
  z-index: 10010;
  bottom: 60px;
  left: 250px;
  font-size: 14px;
  color: var(--text);

  .menuButton {
    display: flex;
    justify-content: space-between;
    padding: 5px 20px;
    border-radius: 5px;

    &:hover {
      background-color: var(--accent);
      color: #ffffff;
    }
  }

  /* 右侧快捷键容器：始终将内容贴右，字母固定宽度，避免不同字符宽度造成图标水平抖动 */
  .menuButton .shortcut {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .menuButton .shortcut span {
    display: inline-block;
    width: 1.5ch; /* 约等于一个数字字符宽，足够容纳 Q/E/F 等 */
    text-align: center; /* 居中，保证不同字符的视觉中心一致 */
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
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

.playerControls {
  .buttonIcon {
    height: 40px;
    width: 40px;
    display: flex;
    justify-content: center;
    align-items: center;

    &:hover {
      filter: contrast(120%) drop-shadow(0px 0px 6px var(--text));
    }
  }

  // 仅移除音量图标的发光
  .volumeIcon:hover {
    filter: none;
  }
}

img {
  width: 20px;
  height: 20px;
}

.volumePopover {
  position: absolute;
  bottom: 38px; // 更贴近图标，轻微重叠，避免鼠标经过间隙
  left: 50%;
  transform: translateX(-50%);
  width: 32px;
  height: 120px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 0;
  z-index: 100;
  // 确保浮层不受任何父级滤镜影响
  filter: none;
}

.volumeBar {
  position: relative;
  width: 6px;
  height: 100%;
  background: var(--border);
  border-radius: 4px;
  cursor: pointer;
  filter: none;
}

.volumeFill {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  background: var(--accent);
  border-radius: 4px;
}

/* 浅色主题下：去掉阴影，用纯黑作为 hover 高亮（适用于白色 PNG 图标） */
.theme-light .playerControls {
  .buttonIcon:hover {
    filter: none;
  }
  .buttonIcon:hover img {
    filter: grayscale(1) brightness(0);
  }
}
</style>
