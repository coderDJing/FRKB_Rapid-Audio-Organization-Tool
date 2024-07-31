<script setup>
import previousSong from '@renderer/assets/previousSong.png'
import fastBackward from '@renderer/assets/fastBackward.png'
import play from '@renderer/assets/play.png'
import pause from '@renderer/assets/pause.png'
import fastForward from '@renderer/assets/fastForward.png'
import nextSong from '@renderer/assets/nextSong.png'
import more from '@renderer/assets/more.png'
import { ref, onUnmounted, watch } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'

const uuid = uuidv4()
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
  'previousSong'
])

const setPlayingValue = (value) => {
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

let fastForwardInterval = null
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

let fastBackwardInterval = null
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

const previousSongRef = ref(null)
const fastBackwardRef = ref(null)
const playRef = ref(null)
const pauseRef = ref(null)
const fastForwardRef = ref(null)
const nextSongRef = ref(null)
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
    <bubbleBox :dom="previousSongRef" title="上一首" shortcut="W" :left="50" />
    <div ref="fastBackwardRef" class="buttonIcon" @mousedown="handleFastBackward()">
      <img :src="fastBackward" draggable="false" />
    </div>
    <bubbleBox :dom="fastBackwardRef" title="快退" shortcut="A" :left="100" />
    <div ref="playRef" class="buttonIcon" v-show="!playing" @click="handlePlay()">
      <img :src="play" draggable="false" />
    </div>
    <bubbleBox :dom="playRef" title="播放" shortcut="Space" :left="150" />
    <div ref="pauseRef" class="buttonIcon" v-show="playing" @click="handlePause()">
      <img :src="pause" draggable="false" />
    </div>
    <bubbleBox :dom="pauseRef" title="暂停" shortcut="Space" :left="150" />
    <div ref="fastForwardRef" class="buttonIcon" @mousedown="handleFastForward()">
      <img :src="fastForward" draggable="false" />
    </div>
    <bubbleBox :dom="fastForwardRef" title="快进" shortcut="D" :left="200" />
    <div ref="nextSongRef" class="buttonIcon" @click="handleNextSong()">
      <img :src="nextSong" draggable="false" />
    </div>
    <bubbleBox :dom="nextSongRef" title="下一首" shortcut="S" :left="250" />
    <div class="buttonIcon" @click.stop="handelMoreClick()">
      <img :src="more" draggable="false" />
    </div>
  </div>
  <transition name="fade">
    <!-- todo加上快捷键icon -->
    <div class="moreMenu" v-if="moreMenuShow">
      <div class="menuButton">
        <span>导出</span>
      </div>
      <div class="menuButton"><span>移动到筛选库</span><span>Q</span></div>
      <div class="menuButton"><span>移动到精选库</span><span>E</span></div>
      <div class="menuButton"><span>删除曲目</span><span>F</span></div>
    </div>
  </transition>
</template>
<style lang="scss" scoped>
.moreMenu {
  width: 200px;
  height: 120px;
  background-color: #202020;
  position: absolute;
  border: 1px solid #424242;
  border-radius: 3px;
  z-index: 99;
  bottom: 60px;
  left: 250px;
  padding: 5px 5px;
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
    cursor: pointer;

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
