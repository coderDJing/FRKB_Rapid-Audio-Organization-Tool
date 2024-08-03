<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIcon from '@renderer/assets/musicIcon.png'
import playerControls from '../../components/playerControls.vue'
import hotkeys from 'hotkeys-js'
import confirm from '@renderer/components/confirmDialog.js'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import libraryUtils from '@renderer/utils/libraryUtils.js'
const runtime = useRuntimeStore()
const waveform = ref(null)
let wavesurferInstance = null

const canvas = document.createElement('canvas')
canvas.height = 50
const ctx = canvas.getContext('2d')

// Define the waveform gradient
const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
gradient.addColorStop(0, '#cccccc') // Top color
gradient.addColorStop(1, '#cccccc') // Bottom color

const progressGradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
progressGradient.addColorStop(0, '#0078d4') // Top color
progressGradient.addColorStop(1, '#0078d4') // Bottom color
const waveformShow = ref(false)

const playerControlsRef = ref(null)
onMounted(() => {
  // 初始化 WaveSurfer 实例
  wavesurferInstance = WaveSurfer.create({
    container: waveform.value,
    waveColor: gradient,
    progressColor: progressGradient,
    barWidth: 2,
    autoplay: true,
    // barAlign: 'bottom',
    height: 40
  })

  // Hover effect
  {
    const hover = document.querySelector('#hover')
    const waveform = document.querySelector('#waveform')
    waveform.addEventListener('pointermove', (e) => (hover.style.width = `${e.offsetX}px`))
  }

  // Current time & duration
  {
    const formatTime = (seconds) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    const timeEl = document.querySelector('#time')
    const durationEl = document.querySelector('#duration')
    wavesurferInstance.on('decode', (duration) => (durationEl.textContent = formatTime(duration)))
    wavesurferInstance.on(
      'timeupdate',
      (currentTime) => (timeEl.textContent = formatTime(currentTime))
    )
    wavesurferInstance.on('finish', () => {
      console.log('finish')
    })
    wavesurferInstance.on('pause', () => {
      playerControlsRef.value.setPlayingValue(false)
    })
    wavesurferInstance.on('play', () => {
      playerControlsRef.value.setPlayingValue(true)
    })
  }
})
watch(
  () => runtime.playingData.playingSong,
  () => {
    if (runtime.playingData.playingSong === null) {
      waveformShow.value = false
      wavesurferInstance.empty()
    }
  }
)
onUnmounted(() => {
  // 组件卸载时销毁 WaveSurfer 实例
  if (wavesurferInstance) {
    wavesurferInstance.destroy()
    wavesurferInstance = null
  }
})

const songInfoShow = ref(false)
const coverBlobUrl = ref('')
window.electron.ipcRenderer.on('readedSongFile', (event, audioData) => {
  const uint8Buffer = Uint8Array.from(audioData)
  const blob = new Blob([uint8Buffer])
  waveformShow.value = true
  wavesurferInstance.loadBlob(blob)
  if (runtime.playingData.playingSong.cover) {
    if (coverBlobUrl.value) {
      URL.revokeObjectURL(coverBlobUrl.value)
    }
    let coverBlob = new Blob([Uint8Array.from(runtime.playingData.playingSong.cover.data)], {
      type: runtime.playingData.playingSong.cover.format
    })
    coverBlobUrl.value = URL.createObjectURL(coverBlob)
  } else {
    if (coverBlobUrl.value) {
      URL.revokeObjectURL(coverBlobUrl.value)
    }
    coverBlobUrl.value = ''
  }
})

onMounted(() => {
  hotkeys('space', 'windowGlobal', () => {
    if (waveformShow.value) {
      if (wavesurferInstance.isPlaying()) {
        pause()
      } else {
        play()
      }
    }
    return false
  })

  hotkeys('d', 'windowGlobal', () => {
    if (waveformShow.value) {
      fastForward()
    }
    return false
  })
  hotkeys('a', 'windowGlobal', () => {
    if (waveformShow.value) {
      fastBackward()
    }
    return false
  })
  hotkeys('s', 'windowGlobal', () => {
    if (runtime.selectSongListDialogShow) {
      return
    }

    if (waveformShow.value) {
      nextSong()
    }
    return false
  })
  hotkeys('w', 'windowGlobal', () => {
    if (runtime.selectSongListDialogShow) {
      return
    }
    if (waveformShow.value) {
      previousSong()
    }
    return false
  })
  hotkeys('F', 'windowGlobal', () => {
    if (showDelConfirm || runtime.confirmShow) {
      return
    }

    runtime.activeMenuUUID = ''
    showDelConfirm = true
    delSong()
  })

  hotkeys('q', 'windowGlobal', () => {
    if (waveformShow.value && !runtime.selectSongListDialogShow) {
      moveToListLibrary()
    }
  })

  hotkeys('e', 'windowGlobal', () => {
    if (waveformShow.value && !runtime.selectSongListDialogShow) {
      moveToLikeLibrary()
    }
  })
})

const play = () => {
  wavesurferInstance.play()
}
const pause = () => {
  wavesurferInstance.pause()
}

const fastForward = () => {
  wavesurferInstance.skip(10)
}

const fastBackward = () => {
  wavesurferInstance.skip(-5)
}

const nextSong = () => {
  let index = runtime.playingData.playingSongListData.findIndex((item) => {
    return item.filePath === runtime.playingData.playingSong.filePath
  })
  if (index === runtime.playingData.playingSongListData.length - 1) {
    return
  }
  runtime.playingData.playingSong = runtime.playingData.playingSongListData[index + 1]
  window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
}

const previousSong = () => {
  let index = runtime.playingData.playingSongListData.findIndex((item) => {
    return item.filePath === runtime.playingData.playingSong.filePath
  })
  if (index === 0) {
    return
  }
  runtime.playingData.playingSong = runtime.playingData.playingSongListData[index - 1]
  window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
}
let showDelConfirm = false

const delSong = async () => {
  let res = await confirm({
    title: '删除',
    content: ['确定删除选中的曲目吗', '（曲目将在磁盘上被删除，但声音指纹依然会保留）'],
    confirmHotkey: 'F'
  })
  showDelConfirm = false
  if (res === 'confirm') {
    let filePath = runtime.playingData.playingSong.filePath
    window.electron.ipcRenderer.send('delSongs', [filePath])
    let index = runtime.playingData.playingSongListData.findIndex((item) => {
      return item.filePath === filePath
    })
    if (index === runtime.playingData.playingSongListData.length - 1) {
      runtime.playingData.playingSongListData.splice(index, 1)
      runtime.playingData.playingSong = null
    } else {
      runtime.playingData.playingSong = runtime.playingData.playingSongListData[index + 1]
      runtime.playingData.playingSongListData.splice(index, 1)
      window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
    }
  }
}
const selectSongListDialogLibraryName = ref('筛选库')
const selectSongListDialogConfirmHotkey = ref('E')
const selectSongListDialogShow = ref(false)

const moveToListLibrary = () => {
  selectSongListDialogLibraryName.value = '筛选库'
  selectSongListDialogConfirmHotkey.value = 'Q'
  selectSongListDialogShow.value = true
}

const moveToLikeLibrary = () => {
  selectSongListDialogLibraryName.value = '精选库'
  selectSongListDialogConfirmHotkey.value = 'E'
  selectSongListDialogShow.value = true
}
const selectSongListDialogConfirm = async (item) => {
  selectSongListDialogShow.value = false
  if (item === runtime.playingData.playingSongListUUID) {
    return
  }
  await window.electron.ipcRenderer.invoke(
    'moveSongsToDir',
    [runtime.playingData.playingSong.filePath],
    libraryUtils.findDirPathByUuid(runtime.libraryTree, item)
  )
  let filePath = runtime.playingData.playingSong.filePath

  let index = runtime.playingData.playingSongListData.findIndex((item) => {
    return item.filePath === filePath
  })
  if (index === runtime.playingData.playingSongListData.length - 1) {
    runtime.playingData.playingSongListData.splice(index, 1)
    runtime.playingData.playingSong = null
  } else {
    runtime.playingData.playingSong = runtime.playingData.playingSongListData[index + 1]
    runtime.playingData.playingSongListData.splice(index, 1)
    window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
  }
  if (item === runtime.selectedSongListUUID) {
    runtime.selectedSongListUUID = ''
    nextTick(() => {
      runtime.selectedSongListUUID = item
    })
  }
}
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
      <div v-if="songInfoShow" @mouseleave="songInfoShow = false" class="songInfo">
        <div class="cover unselectable">
          <img
            v-if="coverBlobUrl"
            :src="coverBlobUrl"
            style="width: 280px; height: 280px"
            draggable="false"
          />
          <img v-else :src="musicIcon" style="width: 48px; height: 48px" draggable="false" />
        </div>
        <div style="font-size: 14px" class="info">
          {{ runtime.playingData.playingSong.title }}
        </div>
        <div style="font-size: 12px" class="info">
          {{ runtime.playingData.playingSong.artist }}
        </div>
        <div style="font-size: 10px" class="info">
          {{ runtime.playingData.playingSong.album }}
        </div>
        <div style="font-size: 10px" class="info">
          {{ runtime.playingData.playingSong.label }}
        </div>
      </div>
    </transition>
    <div style="width: 260px" v-show="waveformShow">
      <playerControls
        ref="playerControlsRef"
        @pause="pause"
        @play="play"
        @fastForward="fastForward"
        @fastBackward="fastBackward"
        @nextSong="nextSong"
        @previousSong="previousSong"
        @delSong="delSong"
        @moveToListLibrary="moveToListLibrary"
        @moveToLikeLibrary="moveToLikeLibrary"
      />
    </div>
    <div style="flex-grow: 1" class="unselectable">
      <div id="waveform" ref="waveform" v-show="waveformShow">
        <div id="time">0:00</div>
        <div id="duration">0:00</div>
        <div id="hover"></div>
      </div>
    </div>
  </div>
  <selectSongListDialog
    v-if="selectSongListDialogShow"
    :libraryName="selectSongListDialogLibraryName"
    :confirmHotkey="selectSongListDialogConfirmHotkey"
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
  cursor: pointer;
  position: relative;
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
