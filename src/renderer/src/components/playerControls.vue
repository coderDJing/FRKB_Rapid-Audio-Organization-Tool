<script setup>
import previousSong from '@renderer/assets/previousSong.png'
import fastBackward from '@renderer/assets/fastBackward.png'
import play from '@renderer/assets/play.png'
import pause from '@renderer/assets/pause.png'
import fastForward from '@renderer/assets/fastForward.png'
import nextSong from '@renderer/assets/nextSong.png'
import more from '@renderer/assets/more.png'
import { ref, onUnmounted } from 'vue'
const playing = ref(true)

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
    <div @click="handlePreviousSong()">
      <img :src="previousSong" draggable="false" />
    </div>
    <div @mousedown="handleFastBackward()">
      <img :src="fastBackward" draggable="false" />
    </div>
    <div v-if="!playing" @click="handlePlay()">
      <img :src="play" draggable="false" />
    </div>
    <div v-if="playing" @click="handlePause()">
      <img :src="pause" draggable="false" />
    </div>
    <div @mousedown="handleFastForward()">
      <img :src="fastForward" draggable="false" />
    </div>
    <div @click="handleNextSong()">
      <img :src="nextSong" draggable="false" />
    </div>
    <div>
      <img :src="more" draggable="false" />
    </div>
  </div>
</template>
<style lang="scss" scoped>
.playerControls {
  div {
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
