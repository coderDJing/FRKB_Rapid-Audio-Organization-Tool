<script setup lang="ts">
defineProps<{
  coverUrl: string
  placeholderSrc: string
  titleText: string
  artistText: string
  albumText: string
  labelText: string
}>()

const emit = defineEmits<{
  coverContextmenu: [event: MouseEvent]
}>()
</script>

<template>
  <div class="songInfo unselectable">
    <div class="cover unselectable" @contextmenu.prevent="emit('coverContextmenu', $event)">
      <img v-if="coverUrl" :src="coverUrl" style="width: 280px; height: 280px" draggable="false" />
      <img v-else :src="placeholderSrc" style="width: 48px; height: 48px" draggable="false" />
    </div>
    <div style="font-size: 14px" class="info">{{ titleText }}</div>
    <div style="font-size: 12px" class="info">{{ artistText }}</div>
    <div style="font-size: 10px" class="info">{{ albumText }}</div>
    <div style="font-size: 10px" class="info">{{ labelText }}</div>
  </div>
</template>

<style lang="scss" scoped>
.songInfo {
  box-sizing: content-box;
  width: 300px;
  height: 370px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding-top: 10px;
  color: var(--text);

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
</style>
