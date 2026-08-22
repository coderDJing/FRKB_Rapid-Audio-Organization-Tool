<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { MINI_PLAYER_CHANNELS, type MiniPlayerTooltipPayload } from '@shared/miniPlayerWindow'
import shortcutIconAsset from '@renderer/assets/shortcutIcon.svg?asset'

const shortcutIcon = shortcutIconAsset
const payload = ref<MiniPlayerTooltipPayload | null>(null)
const rootRef = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

const reportSize = async () => {
  await nextTick()
  const el = rootRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.tooltipContentSize, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height)
  })
}

const observeBubble = () => {
  resizeObserver?.disconnect()
  const el = rootRef.value
  if (!el) return
  resizeObserver = new ResizeObserver(() => {
    void reportSize()
  })
  resizeObserver.observe(el)
}

const handleState = (_event: unknown, next: MiniPlayerTooltipPayload | null) => {
  payload.value = next
  if (!next) {
    resizeObserver?.disconnect()
    resizeObserver = null
    return
  }
  void nextTick().then(() => {
    observeBubble()
    void reportSize()
  })
}

onMounted(() => {
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.tooltipState, handleState)
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.tooltipReady)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.tooltipState, handleState)
})
</script>

<template>
  <div
    v-if="payload"
    ref="rootRef"
    class="frkb-bubble unselectable"
    :style="{ maxWidth: `${payload.maxWidth}px` }"
  >
    <div class="frkb-bubble-row">
      <span>{{ payload.title }}</span>
      <div v-if="payload.shortcut" class="frkb-bubble-shortcut">
        <img :src="shortcutIcon" draggable="false" alt="" />
        <span>{{ payload.shortcut }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.frkb-bubble {
  display: inline-block;
  width: max-content;
  box-sizing: border-box;
  background-color: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
}

.frkb-bubble-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: max-content;
  max-width: 100%;
}

.frkb-bubble-row > span {
  flex: 0 1 auto;
  white-space: nowrap;
}

.frkb-bubble-shortcut {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  img {
    width: 16px;
    height: 16px;
  }
}
</style>
