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
  textContextmenu: [event: MouseEvent, text: string]
}>()

const emitTextContextmenu = (event: MouseEvent, text: string) => {
  emit('textContextmenu', event, text)
}
</script>

<template>
  <div class="songInfo">
    <div class="cover unselectable" @contextmenu.prevent="emit('coverContextmenu', $event)">
      <img v-if="coverUrl" :src="coverUrl" style="width: 280px; height: 280px" draggable="false" />
      <img v-else :src="placeholderSrc" style="width: 48px; height: 48px" draggable="false" />
    </div>
    <div
      class="info selectable"
      style="font-size: 14px"
      @contextmenu.prevent="emitTextContextmenu($event, titleText)"
    >
      {{ titleText }}
    </div>
    <div
      class="info selectable"
      style="font-size: 12px"
      @contextmenu.prevent="emitTextContextmenu($event, artistText)"
    >
      {{ artistText }}
    </div>
    <div
      class="info selectable"
      style="font-size: 10px"
      @contextmenu.prevent="emitTextContextmenu($event, albumText)"
    >
      {{ albumText }}
    </div>
    <div
      class="info selectable"
      style="font-size: 10px"
      @contextmenu.prevent="emitTextContextmenu($event, labelText)"
    >
      {{ labelText }}
    </div>
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
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
  }
}
</style>
