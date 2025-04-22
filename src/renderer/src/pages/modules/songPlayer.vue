<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick, useTemplateRef } from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIcon from '@renderer/assets/musicIcon.png?asset'
import playerControls from '../../components/playerControls.vue'
import hotkeys from 'hotkeys-js'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import exportDialog from '@renderer/components/exportDialog'
import { t } from '@renderer/utils/translate'
import * as realtimeBpm from 'realtime-bpm-analyzer'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { getCurrentTimeDirName } from '@renderer/utils/utils'

const runtime = useRuntimeStore()
const waveform = useTemplateRef('waveform')
let wavesurferInstance: WaveSurfer | null = null

const canvas = document.createElement('canvas')
canvas.height = 50
const ctx = canvas.getContext('2d')

// Define the waveform gradient
if (ctx === null) {
  throw new Error('ctx is null')
}
const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
gradient.addColorStop(0, '#cccccc') // Top color
gradient.addColorStop(1, '#cccccc') // Bottom color

const progressGradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
progressGradient.addColorStop(0, '#0078d4') // Top color
progressGradient.addColorStop(1, '#0078d4') // Bottom color
const waveformShow = ref(false)

const playerControlsRef = useTemplateRef('playerControlsRef')
onMounted(() => {
  // 初始化 WaveSurfer 实例
  if (waveform.value === null) {
    throw new Error('waveform is null')
  }
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
  // Hover effect
  {
    const hover = document.querySelector<HTMLElement>('#hover')
    if (hover === null) {
      throw new Error('hover is null')
    }
    const waveform = document.querySelector<HTMLElement>('#waveform')
    if (waveform === null) {
      throw new Error('waveform is null')
    }
    waveform.addEventListener('pointermove', (e) => (hover.style.width = `${e.offsetX}px`))
  }

  // Current time & duration
  {
    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    const timeEl = document.querySelector('#time')
    if (timeEl === null) {
      throw new Error('timeEl is null')
    }
    const durationEl = document.querySelector('#duration')
    if (durationEl === null) {
      throw new Error('durationEl is null')
    }
    wavesurferInstance.on('decode', (duration) => (durationEl.textContent = formatTime(duration)))
    wavesurferInstance.on(
      'timeupdate',
      (currentTime) => (timeEl.textContent = formatTime(currentTime))
    )
    wavesurferInstance.on('finish', () => {
      if (runtime.setting.autoPlayNextSong) {
        nextSong()
      }
    })
    wavesurferInstance.on('pause', () => {
      playerControlsRef.value?.setPlayingValue(false)
    })
    wavesurferInstance.on('play', () => {
      playerControlsRef.value?.setPlayingValue(true)
    })
    wavesurferInstance.on('error', async (error) => {
      if (error === undefined) {
        return
      }
      if (runtime.playingData.playingSong === null) {
        throw new Error('playingData.playingSong is null')
      }
      let filePath = runtime.playingData.playingSong.filePath
      let res = await confirm({
        title: '错误',
        content: [t('该文件无法播放，是否直接删除'), t('（文件内容不是音频或文件已损坏）')]
      })
      if (res !== 'cancel') {
        window.electron.ipcRenderer.send('delSongs', [filePath], getCurrentTimeDirName())
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
      } else {
        nextSong()
      }
    })
  }
})
watch(
  () => runtime.playingData.playingSong,
  () => {
    if (runtime.playingData.playingSong === null) {
      waveformShow.value = false
      wavesurferInstance?.empty()
      runtime.playingData.playingSongListUUID = ''
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
const audioContext = new AudioContext()
const bpm = ref<number | string>('')
window.electron.ipcRenderer.on('readedSongFile', async (event, audioData) => {
  const uint8Buffer = audioData
  const blob = new Blob([uint8Buffer])
  if (runtime.playingData.playingSong === null) {
    throw new Error('playingData.playingSong is null')
  }
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
  waveformShow.value = true
  bpm.value = ''
  await wavesurferInstance?.loadBlob(blob)
  const arrayBuffer = uint8Buffer.buffer
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
  realtimeBpm.analyzeFullBuffer(audioBuffer).then((topCandidates) => {
    bpm.value = topCandidates[0].tempo
  })
})

onMounted(() => {
  hotkeys('space', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (wavesurferInstance?.isPlaying()) {
      pause()
    } else {
      play()
    }
    return false
  })

  hotkeys('d,right', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }

    fastForward()

    return false
  })
  hotkeys('a,left', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }

    fastBackward()

    return false
  })
  hotkeys('s,down', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (runtime.selectSongListDialogShow) {
      return
    }

    nextSong()

    return false
  })
  hotkeys('w,up', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (runtime.selectSongListDialogShow) {
      return
    }

    previousSong()

    return false
  })
  hotkeys('F,delete', 'windowGlobal', (keyEvent) => {
    if (!waveformShow.value) {
      return
    }
    if (keyEvent.code === 'Delete' && runtime.songsArea.selectedSongFilePath.length > 0) {
      return
    }
    if (showDelConfirm || runtime.confirmShow) {
      return
    }
    runtime.activeMenuUUID = ''
    showDelConfirm = true
    delSong()
  })

  hotkeys('q', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (!runtime.selectSongListDialogShow) {
      moveToListLibrary()
    }
  })

  hotkeys('e', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (!runtime.selectSongListDialogShow) {
      moveToLikeLibrary()
    }
  })
})

const play = () => {
  wavesurferInstance?.play()
}
const pause = () => {
  wavesurferInstance?.pause()
}

const fastForward = () => {
  wavesurferInstance?.skip(runtime.setting.fastForwardTime)
}

const fastBackward = () => {
  wavesurferInstance?.skip(runtime.setting.fastBackwardTime)
}

// let nextSongDebounceTimeout = null
const nextSong = () => {
  if (runtime.playingData.playingSong === null) {
    throw new Error('playingData.playingSong is null')
  }
  let index = runtime.playingData.playingSongListData.findIndex((item) => {
    return item.filePath === runtime.playingData.playingSong?.filePath
  })
  if (index === runtime.playingData.playingSongListData.length - 1) {
    return
  }
  runtime.playingData.playingSong = runtime.playingData.playingSongListData[index + 1]
  // if (nextSongDebounceTimeout !== null) {
  //   clearTimeout(nextSongDebounceTimeout)
  // }
  // nextSongDebounceTimeout = setTimeout(() => {
  window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
  // }, 300)
}

// let previousSongDebounceTimeout = null
const previousSong = () => {
  if (runtime.playingData.playingSong === null) {
    throw new Error('playingData.playingSong is null')
  }
  let index = runtime.playingData.playingSongListData.findIndex((item) => {
    return item.filePath === runtime.playingData.playingSong?.filePath
  })
  if (index === 0) {
    return
  }
  runtime.playingData.playingSong = runtime.playingData.playingSongListData[index - 1]
  // if (previousSongDebounceTimeout !== null) {
  //   clearTimeout(previousSongDebounceTimeout)
  // }
  // previousSongDebounceTimeout = setTimeout(() => {
  window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
  // }, 300)
}
let showDelConfirm = false

const delSong = async () => {
  if (runtime.playingData.playingSong === null) {
    throw new Error('playingData.playingSong is null')
  }

  const filePath = runtime.playingData.playingSong.filePath
  const isInRecycleBin = runtime.libraryTree.children
    ?.find((item) => item.dirName === '回收站')
    ?.children?.find((item) => item.uuid === runtime.playingData.playingSongListUUID)

  if (isInRecycleBin) {
    const res = await confirm({
      title: '删除',
      content: [
        t('确定彻底删除正在播放的曲目吗'),
        t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
      ]
    })
    showDelConfirm = false

    if (res !== 'confirm') {
      return
    }
    window.electron.ipcRenderer.invoke('permanentlyDelSongs', [filePath])
  } else {
    showDelConfirm = false
    window.electron.ipcRenderer.send('delSongs', [filePath], getCurrentTimeDirName())
  }

  const index = runtime.playingData.playingSongListData.findIndex(
    (item) => item.filePath === filePath
  )

  runtime.playingData.playingSongListData.splice(index, 1)

  if (index === runtime.playingData.playingSongListData.length) {
    runtime.playingData.playingSong = null
  } else {
    runtime.playingData.playingSong = runtime.playingData.playingSongListData[index]
    window.electron.ipcRenderer.send('readSongFile', runtime.playingData.playingSong.filePath)
  }
}
const selectSongListDialogLibraryName = ref('筛选库')
const selectSongListDialogShow = ref(false)

const moveToListLibrary = () => {
  selectSongListDialogLibraryName.value = '筛选库'
  selectSongListDialogShow.value = true
}

const moveToLikeLibrary = () => {
  selectSongListDialogLibraryName.value = '精选库'
  selectSongListDialogShow.value = true
}

const selectSongListDialogConfirm = async (item: string) => {
  selectSongListDialogShow.value = false
  if (item === runtime.playingData.playingSongListUUID) {
    return
  }
  if (runtime.playingData.playingSong === null) {
    throw new Error('playingData.playingSong is null')
  }
  await window.electron.ipcRenderer.invoke(
    'moveSongsToDir',
    [runtime.playingData.playingSong.filePath],
    libraryUtils.findDirPathByUuid(item)
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
  if (item === runtime.songsArea.songListUUID) {
    runtime.songsArea.songListUUID = ''
    nextTick(() => {
      runtime.songsArea.songListUUID = item
    })
  }
}

const exportTrack = async () => {
  let result = await exportDialog({ title: '曲目' })
  if (result !== 'cancel') {
    let folderPathVal = result.folderPathVal
    let deleteSongsAfterExport = result.deleteSongsAfterExport
    await window.electron.ipcRenderer.invoke(
      'exportSongsToDir',
      folderPathVal,
      deleteSongsAfterExport,
      JSON.parse(JSON.stringify([runtime.playingData.playingSong]))
    )
    if (deleteSongsAfterExport) {
      if (runtime.playingData.playingSong === null) {
        throw new Error('playingData.playingSong is null')
      }
      let filePath = runtime.playingData.playingSong.filePath
      if (runtime.playingData.playingSong.coverUrl) {
        URL.revokeObjectURL(runtime.playingData.playingSong.coverUrl)
      }
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
}

const bpmDomRef = useTemplateRef('bpmDomRef')
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
        @pause="pause"
        @play="play"
        @fastForward="fastForward"
        @fastBackward="fastBackward"
        @nextSong="nextSong"
        @previousSong="previousSong"
        @delSong="delSong"
        @moveToListLibrary="moveToListLibrary"
        @moveToLikeLibrary="moveToLikeLibrary"
        @exportTrack="exportTrack"
      />
    </div>

    <div style="flex-grow: 1" class="unselectable">
      <div id="waveform" ref="waveform" v-show="waveformShow">
        <div id="time">0:00</div>
        <div id="duration">0:00</div>
        <div id="hover"></div>
      </div>
    </div>
    <div
      class="unselectable"
      ref="bpmDomRef"
      style="
        width: 50px;
        display: flex;
        justify-content: center;
        align-items: center;
        font-size: 16px;
        font-weight: bold;
      "
      v-show="waveformShow"
    >
      {{ bpm }}
    </div>
    <bubbleBox :dom="bpmDomRef || undefined" title="BPM" :right="1" :width="60" />
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
