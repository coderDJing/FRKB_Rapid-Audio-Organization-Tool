<script setup>
import shortcutIcon from '@renderer/assets/shortcutIcon.png'
import { watch, onUnmounted, ref } from 'vue'
const props = defineProps({
  dom: {
    type: Object
  },
  title: {
    type: String
  },
  shortcut: {
    type: String
  },
  left: {
    type: Number
  }
})

let hoverTimer = null
let show = ref(false)
const mouseover = () => {
  hoverTimer = setTimeout(() => {
    show.value = true
  }, 500)
}
const mouseout = () => {
  clearTimeout(hoverTimer)
  show.value = false
}
watch(
  () => props.dom,
  () => {
    if (props.dom !== null) {
      props.dom.addEventListener('mouseover', mouseover)
      props.dom.addEventListener('mouseout', mouseout)
    }
  }
)

onUnmounted(() => {
  props.dom.removeEventListener('mouseover', mouseover)
  props.dom.removeEventListener('mouseout', mouseout)
})
</script>
<template>
  <transition name="fade">
    <div
      class="bubbleBox"
      v-if="show"
      style="position: absolute; bottom: 55px"
      :style="[{ left: props.left + 'px' }]"
    >
      <span>{{ props.title }}</span>
      <div><img :src="shortcutIcon" :draggable="false" />{{ props.shortcut }}</div>
    </div>
  </transition>
</template>
<style lang="scss" scoped>
.bubbleBox {
  width: 100px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  position: relative;
  border-radius: 3px;
  border: 1px solid #424242;
  font-size: 12px;
  background-color: #202020;
  padding: 0 10px;
  font-weight: normal;
  display: flex;
  justify-content: space-between;
  z-index: 200;

  div {
    display: flex;
    align-items: center;

    img {
      width: 20px;
      height: 20px;
      margin-right: 5px;
    }
  }
}
</style>
