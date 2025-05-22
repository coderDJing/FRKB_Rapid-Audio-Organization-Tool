<script setup lang="ts">
import { PropType } from 'vue'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'

defineProps({
  songs: {
    type: Array as PropType<ISongInfo[]>,
    required: true
  },
  visibleColumns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  selectedSongFilePaths: {
    type: Array as PropType<string[]>,
    required: true
  },
  playingSongFilePath: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  totalWidth: {
    type: Number,
    required: true
  }
})

defineEmits<{
  (e: 'song-click', event: MouseEvent, song: ISongInfo): void
  (e: 'song-contextmenu', event: MouseEvent, song: ISongInfo): void
  (e: 'song-dblclick', song: ISongInfo): void
}>()
</script>

<template>
  <div>
    <!-- Outer wrapper for all song rows -->
    <div
      v-for="(song, index) in songs"
      :key="song.filePath"
      class="song-row-item unselectable"
      @click.stop="$emit('song-click', $event, song)"
      @contextmenu.stop="$emit('song-contextmenu', $event, song)"
      @dblclick.stop="$emit('song-dblclick', song)"
    >
      <div
        class="song-row-content"
        :class="{
          lightBackground: index % 2 === 1 && !selectedSongFilePaths.includes(song.filePath),
          darkBackground: index % 2 === 0 && !selectedSongFilePaths.includes(song.filePath),
          selectedSong: selectedSongFilePaths.includes(song.filePath),
          playingSong: song.filePath === playingSongFilePath
        }"
        :style="{ 'min-width': totalWidth + 'px' }"
      >
        <template v-for="col in visibleColumns" :key="col.key">
          <div
            v-if="col.key === 'coverUrl'"
            class="cell-cover"
            :style="{ width: col.width + 'px' }"
          >
            <img v-if="song.coverUrl" :src="song.coverUrl" class="unselectable" draggable="false" />
            <div v-else class="cover-placeholder"></div>
          </div>
          <div
            v-else-if="col.key === 'index'"
            class="cell-title"
            :style="{ width: col.width + 'px' }"
          >
            {{ index + 1 }}
          </div>
          <div v-else class="cell-title" :style="{ width: col.width + 'px' }">
            {{ song[col.key as keyof ISongInfo] }}
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.song-row-item {
  font-size: 14px;
  // Any specific styles for the outer clickable wrapper of a row (if needed beyond events)
}

.song-row-content {
  display: flex;
  height: 30px; // Standard row height

  &.lightBackground {
    background-color: #191919;
  }
  &.darkBackground {
    background-color: #000000;
  }
  &.selectedSong {
    background-color: #37373d;
  }
  &.playingSong {
    color: #0078d4 !important;
    font-weight: bold;
  }
}

.cell-cover,
.cell-title {
  height: 100%; // Fill the row height
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  border-bottom: 1px solid #2b2b2b;
  display: flex; // For vertical centering in title cells
  align-items: center; // For vertical centering in title cells
  flex-shrink: 0;
}

.cell-cover {
  overflow: hidden; // Ensure cover image respects bounds
  padding-left: 0; // Covers usually don't have left padding

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block; // Remove potential space below image
  }
  .cover-placeholder {
    width: 100%;
    height: 100%;
    // background-color: #2a2a2a; // Optional: placeholder background
  }
}

.cell-title {
  padding-left: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis; // Added for better text handling
}

.unselectable {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
</style>
