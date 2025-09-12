<script setup lang="ts">
import previousSong from '@renderer/assets/previousSong.png?asset'
import fastBackward from '@renderer/assets/fastBackward.png?asset'
import play from '@renderer/assets/play.png?asset'
import pause from '@renderer/assets/pause.png?asset'
import fastForward from '@renderer/assets/fastForward.png?asset'
import nextSong from '@renderer/assets/nextSong.png?asset'
import more from '@renderer/assets/more.png?asset'
import { ref, onUnmounted, watch, useTemplateRef, onMounted, computed } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import shortcutIcon from '@renderer/assets/shortcutIcon.png?asset'
import { t } from '@renderer/utils/translate'
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
    <bubbleBox :dom="fastBackwardRef || undefined" :title="t('player.fastBackward')" shortcut="A" />
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
    <div class="buttonIcon" @click.stop="handelMoreClick()">
      <img :src="more" draggable="false" />
    </div>
  </div>
  <transition name="fade">
    <div class="moreMenu unselectable" v-if="moreMenuShow">
      <div style="padding: 5px 5px; border-bottom: 1px solid #454545">
        <div class="menuButton" @click="exportTrack()">
          <span>{{ t('tracks.exportTracks') }}</span>
        </div>
      </div>
      <div style="padding: 5px 5px; border-bottom: 1px solid #454545">
        <div class="menuButton" @click="moveToListLibrary()">
          <div>
            <span>{{ t('library.moveToFilter') }}</span>
          </div>
          <div style="display: flex; align-items: center">
            <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" />
            <span>Q</span>
          </div>
        </div>
        <div class="menuButton" @click="moveToLikeLibrary()">
          <div>
            <span>{{ t('library.moveToCurated') }}</span>
          </div>
          <div style="display: flex; align-items: center">
            <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>E</span>
          </div>
        </div>
      </div>
      <div style="padding: 5px 5px; border-bottom: 1px solid #454545">
        <div class="menuButton" @click="delSong()">
          <div>
            <span>{{ t('tracks.deleteTracks') }} </span>
          </div>
          <div style="display: flex; align-items: center">
            <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>F</span>
          </div>
        </div>
      </div>
      <div style="padding: 5px 5px">
        <div class="menuButton" @click="showInFileExplorer()">
          <span>{{ t('tracks.showInFileExplorer') }}</span>
        </div>
      </div>
    </div>
  </transition>
</template>
<style lang="scss" scoped>
.moreMenu {
  width: 250px;
  // height: 120px;
  background-color: #202020;
  position: absolute;
  border: 1px solid #424242;
  border-radius: 3px;
  z-index: 99;
  bottom: 60px;
  left: 250px;
  // padding: 5px 5px;
  font-size: 14px;

  .menuButton {
    display: flex;
    justify-content: space-between;
    padding: 5px 20px;
    border-radius: 5px;

    &:hover {
      background-color: #0078d4;
      color: white;
    }
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
      filter: contrast(200%) drop-shadow(0px 0px 10px #fff);
    }
  }
}

img {
  width: 20px;
  height: 20px;
}
</style>
