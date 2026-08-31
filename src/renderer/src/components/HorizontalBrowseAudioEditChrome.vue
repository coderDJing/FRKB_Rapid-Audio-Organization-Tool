<script setup lang="ts">
import HorizontalBrowseAudioEditSaveDialog from '@renderer/components/HorizontalBrowseAudioEditSaveDialog.vue'
import HorizontalBrowseAudioEditLeaveDialog from '@renderer/components/HorizontalBrowseAudioEditLeaveDialog.vue'

defineProps<{
  saveOpen: boolean
  leaveOpen: boolean
  originalTitle: string
  originalFormat: string
  versionPreviewName: string
  losslessSource: boolean
}>()

const emit = defineEmits<{
  (
    event: 'confirm-save',
    payload: { target: 'overwrite' | 'new-version'; format: 'original' | 'wav' }
  ): void
  (event: 'cancel-save'): void
  (event: 'leave-save'): void
  (event: 'leave-discard'): void
  (event: 'leave-cancel'): void
}>()
</script>

<template>
  <HorizontalBrowseAudioEditSaveDialog
    v-if="saveOpen"
    :original-title="originalTitle"
    :original-format="originalFormat"
    :version-preview-name="versionPreviewName"
    :lossless-source="losslessSource"
    @confirm="emit('confirm-save', $event)"
    @cancel="emit('cancel-save')"
  />
  <HorizontalBrowseAudioEditLeaveDialog
    v-if="leaveOpen"
    @save="emit('leave-save')"
    @discard="emit('leave-discard')"
    @cancel="emit('leave-cancel')"
  />
</template>
