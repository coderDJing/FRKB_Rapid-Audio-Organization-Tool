<script setup>
import librarySelectArea from './modules/librarySelectArea.vue'
import libraryArea from './modules/libraryArea.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { onUnmounted, ref } from 'vue'
const runtime = useRuntimeStore()
let startX = 0
let isResizing = false
const isHovered = ref(false)
let hoverTimeout

const handleMouseEnter = () => {
  // 清除之前的定时器，以防用户频繁移动鼠标进出 div
  clearTimeout(hoverTimeout)

  // 设置一个新的定时器，500 毫秒后改变背景色
  hoverTimeout = setTimeout(() => {
    isHovered.value = true
  }, 500)
}

const handleMouseLeave = () => {
  // 清除定时器，因为鼠标已经离开了
  clearTimeout(hoverTimeout)
  if (!isResizing) {
    // 立即将背景色设置回透明
    isHovered.value = false
  }
}
function startResize(e) {
  e.preventDefault && e.preventDefault()
  isResizing = true
  isHovered.value = true
  startX = e.clientX
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', stopResize)
}

function resize(e) {
  if (!isResizing) return
  const deltaX = e.clientX - startX
  const newWidth = Math.max(150, runtime.layoutConfig.libraryAreaWidth + deltaX) // 设置最小宽度
  if (runtime.layoutConfig.libraryAreaWidth + deltaX < 50) {
    runtime.layoutConfig.libraryAreaWidth = 0
  }
  if (newWidth != 150) {
    runtime.layoutConfig.libraryAreaWidth = newWidth
    startX = e.clientX
  }
}

function stopResize() {
  isResizing = false
  isHovered.value = false
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig))
}

onUnmounted(() => {
  // 如果需要，可以在这里添加组件卸载时的清理逻辑
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  clearTimeout(hoverTimeout)
})

let librarySelected = ref('筛选库')
const librarySelectedChange = (item) => {
  if (item.name == librarySelected.value) {
    return
  }
  librarySelected.value = item.name
}
</script>
<template>
  <div style="display: flex; height: 100%">
    <librarySelectArea @librarySelectedChange="librarySelectedChange"></librarySelectArea>
    <div
      style="width: 200px; border-right: 1px solid #2b2b2b"
      :style="'width:' + runtime.layoutConfig.libraryAreaWidth + 'px'"
    >
      <div
        v-for="item of runtime.libraryTree.children"
        style="width: 100%; height: 100%"
        v-show="librarySelected == item.dirName"
      >
        <libraryArea :uuid="item.uuid"></libraryArea>
      </div>
    </div>
    <div
      style="width: 4px; cursor: ew-resize; height: calc(100vh - 35px)"
      @mousedown="startResize"
      class="dragBar"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
      :class="{ dragBarHovered: isHovered }"
    ></div>
    <div style="flex-grow: 1"></div>
  </div>
</template>
<style lang="scss" scoped>
.dragBar {
  background-color: transparent;
  transition: background-color 0.2s ease;
}

.dragBarHovered {
  background-color: #0078d4;
}
</style>
