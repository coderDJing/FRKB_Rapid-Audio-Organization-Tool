<script setup lang="ts">
import { ref, watchEffect, PropType } from 'vue'
import { ISongsAreaColumn } from '../../../../../types/globals'
import SongAreaColRightClickMenu from '@renderer/components/songAreaColRightClickMenu.vue'

const props = defineProps({
  modelValue: Boolean, // for v-model
  targetEvent: {
    type: Object as PropType<MouseEvent | null>,
    default: null
  },
  columns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  scrollHostElement: {
    type: Object as PropType<HTMLElement | null | undefined>,
    default: null
  }
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'toggle-column-visibility', columnKey: string): void
}>()

const internalShow = ref(props.modelValue)

watchEffect(() => {
  internalShow.value = props.modelValue
})

const handleMenuItemClick = (column: ISongsAreaColumn) => {
  emit('toggle-column-visibility', column.key)
  emit('update:modelValue', false) // Close the menu
}

const onMenuVModelUpdate = (value: boolean) => {
  emit('update:modelValue', value)
}
</script>

<template>
  <SongAreaColRightClickMenu
    :model-value="internalShow"
    :click-event="targetEvent"
    :scroll-host-element="scrollHostElement"
    :column-data="columns"
    @update:model-value="onMenuVModelUpdate"
    @col-menu-handle-click="handleMenuItemClick"
  />
</template>

<style scoped>
/* This component is primarily a logic wrapper, so specific styles might not be needed here */
/* Styles for SongAreaColRightClickMenu are within that component itself */
</style>
