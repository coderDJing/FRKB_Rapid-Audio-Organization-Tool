<script setup lang="ts">
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import type { HorizontalBrowseDeckMoveTargetLibrary } from '@renderer/components/useHorizontalBrowseDeckMove'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'

const props = defineProps<{
  visible: boolean
  libraryName: HorizontalBrowseDeckMoveTargetLibrary | ''
  actionMode: LibraryTransferActionMode
}>()

const emit = defineEmits<{
  (event: 'confirm', songListUuid: string): void
  (event: 'cancel'): void
}>()
</script>

<template>
  <selectSongListDialog
    v-if="props.visible"
    :library-name="props.libraryName"
    :action-mode="props.actionMode"
    @confirm="emit('confirm', $event)"
    @cancel="emit('cancel')"
  />
</template>
