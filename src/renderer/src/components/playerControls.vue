<script setup lang="ts">
import previousSongAsset from '@renderer/assets/previousSong.svg?asset'
import fastBackwardAsset from '@renderer/assets/fastBackward.svg?asset'
import playAsset from '@renderer/assets/play.svg?asset'
import pauseAsset from '@renderer/assets/pause.svg?asset'
import fastForwardAsset from '@renderer/assets/fastForward.svg?asset'
import nextSongAsset from '@renderer/assets/nextSong.svg?asset'
import moreAsset from '@renderer/assets/more.svg?asset'
import { ref, onUnmounted, watch, useTemplateRef, onMounted, computed } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import shortcutIconAsset from '@renderer/assets/shortcutIcon.svg?asset'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { resolveLibraryTransferActionModeForPlayback } from '@renderer/utils/libraryTransfer'
const previousSong = previousSongAsset
const fastBackward = fastBackwardAsset
const play = playAsset
const pause = pauseAsset
const fastForward = fastForwardAsset
const nextSong = nextSongAsset
const more = moreAsset
const shortcutIcon = shortcutIconAsset
const uuid = uuidV4()
const runtime = useRuntimeStore()
const isReadOnlyPlaybackSource = computed(() =>
  isRekordboxExternalPlaybackSource(
    runtime.playingData.playingSongListUUID,
    runtime.playingData.playingSong
  )
)
const playbackTransferActionMode = computed(() =>
  resolveLibraryTransferActionModeForPlayback(
    runtime.playingData.playingSongListUUID,
    runtime.playingData.playingSong
  )
)
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
  'moveToMixtapeLibrary',
  'exportTrack'
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
const moveToMixtapeLibrary = () => {
  emits('moveToMixtapeLibrary', runtime.playingData.playingSong)
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
const exportTrackLabel = computed(() =>
  isReadOnlyPlaybackSource.value ? t('tracks.exportTracksCopyOnly') : t('tracks.exportTracks')
)
const moveToFilterLabel = computed(() =>
  playbackTransferActionMode.value === 'copy'
    ? t('library.copyToFilter')
    : t('library.moveToFilter')
)
const moveToCuratedLabel = computed(() =>
  playbackTransferActionMode.value === 'copy'
    ? t('library.copyToCurated')
    : t('library.moveToCurated')
)

defineExpose({
  setPlayingValue
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
      navigator.mediaSession.metadata = null
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
      <div v-show="!playing" ref="playRef" class="buttonIcon" @click="handlePlay()">
        <img :src="play" draggable="false" />
      </div>
      <bubbleBox :dom="playRef || undefined" :title="t('player.play')" shortcut="Space" />
      <div v-show="playing" ref="pauseRef" class="buttonIcon" @click="handlePause()">
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
      <div class="buttonIcon" @click.stop="handelMoreClick()">
        <img :src="more" draggable="false" />
      </div>
    </div>
    <transition name="fade">
      <div v-if="moreMenuShow" class="moreMenu unselectable">
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="exportTrack()">
            <span>{{ exportTrackLabel }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="moveToListLibrary()">
            <div>
              <span>{{ moveToFilterLabel }}</span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>Q</span>
            </div>
          </div>
          <div class="menuButton" @click="moveToLikeLibrary()">
            <div>
              <span>{{ moveToCuratedLabel }}</span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>E</span>
            </div>
          </div>
          <div v-if="isReadOnlyPlaybackSource" class="menuButton" @click="moveToMixtapeLibrary()">
            <span>{{ t('library.addToMixtapeByCopy') }}</span>
          </div>
        </div>
        <div
          v-if="!isReadOnlyPlaybackSource"
          style="padding: 5px 5px; border-bottom: 1px solid var(--border)"
        >
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
  z-index: var(--z-popover);
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
}

img {
  width: 20px;
  height: 20px;
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
