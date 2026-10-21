<script setup lang="ts">
import { computed } from 'vue'
import { splitPlaylistSearchText } from '@renderer/utils/playlistSearchText'

const props = defineProps<{
  value: string | number
  query: string
}>()
const parts = computed(() => splitPlaylistSearchText(props.value, props.query))
</script>

<template>
  <span class="playlist-search-text">
    <template v-for="(part, index) in parts" :key="index">
      <mark v-if="part.matched" class="playlist-search-text__match">{{ part.text }}</mark>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>

<style scoped lang="scss">
.playlist-search-text {
  // 由外层单元格裁切，让气泡锚点仍能通过 scrollWidth 检测文字溢出。
  flex-shrink: 0;
  white-space: nowrap;
}

.playlist-search-text__match {
  padding: 0;
  border-radius: 2px;
  background: var(--song-search-match-bg);
  color: var(--song-search-match-text);
  font: inherit;
  text-shadow: none;
}
</style>
