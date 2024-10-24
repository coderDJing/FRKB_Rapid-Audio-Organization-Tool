<script setup lang="ts">
import shortcutIcon from '@renderer/assets/shortcutIcon.png?asset'
import { watch, onUnmounted, ref } from 'vue'
import { t } from '@renderer/utils/translate'
const props = defineProps({
  dom: {
    type: HTMLElement,
    default: null
  },
  title: {
    type: String,
    default: ''
  },
  shortcut: {
    type: String
  },
  left: {
    type: Number
  },
  right: {
    type: Number
  },
  width: {
    type: Number
  }
})

let hoverTimer: NodeJS.Timeout
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
      :style="[
        {
          left: props.left ? props.left + 'px' : undefined,
          justifyContent: !props.shortcut ? 'center' : 'space-between',
          right: props.right ? props.right + 'px' : undefined,
          width: props.width ? props.width + 'px' : '120px'
        }
      ]"
    >
      <span>{{ t(props.title) }}</span>
      <div v-if="props.shortcut">
        <img :src="shortcutIcon" :draggable="false" />{{ props.shortcut }}
      </div>
    </div>
  </transition>
</template>
<style lang="scss" scoped>
.bubbleBox {
  width: 120px;
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
