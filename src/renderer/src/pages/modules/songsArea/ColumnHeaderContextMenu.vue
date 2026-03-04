<script setup lang="ts">
import { ref, watchEffect, PropType } from 'vue'
import { ISongsAreaColumn } from '../../../../../types/globals'
import SongAreaColRightClickMenu from '@renderer/components/songAreaColRightClickMenu.vue'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'

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

const menuPosition = ref({ x: 0, y: 0 })
const internalShow = ref(props.modelValue)

watchEffect(() => {
  internalShow.value = props.modelValue
})

watchEffect(() => {
  if (props.modelValue && props.targetEvent && props.scrollHostElement) {
    const hostElement = props.scrollHostElement
    const event = props.targetEvent

    const parentRect = hostElement.getBoundingClientRect()

    // Estimate menu dimensions (copied from original songsArea.vue logic)
    // Consider making these props or dynamic if menu content changes significantly
    const menuHeightEstimate = props.columns.length * 40 // Rough estimate
    const menuWidthEstimate = 255 // Rough estimate

    const { x: adjustedAbsoluteX, y: adjustedAbsoluteY } = resolveContextMenuPoint({
      clickX: event.clientX,
      clickY: event.clientY,
      menuWidth: menuWidthEstimate,
      menuHeight: menuHeightEstimate
    })

    // Convert adjusted absolute coordinates back to relative coordinates for the menu component
    const adjustedRelativeX = adjustedAbsoluteX - parentRect.left
    const adjustedRelativeY = adjustedAbsoluteY - parentRect.top

    menuPosition.value = { x: adjustedRelativeX, y: adjustedRelativeY < 0 ? 0 : adjustedRelativeY }
  } else if (props.modelValue && props.targetEvent && !props.scrollHostElement) {
    // Fallback if scrollHostElement is not available (e.g., during initial render)
    // Use clientX/Y directly, though this might not be perfectly positioned within a scroller
    console.warn(
      'ColumnHeaderContextMenu: scrollHostElement not available, using clientX/Y for menu position.'
    )
    const menuHeightEstimate = props.columns.length * 40
    const menuWidthEstimate = 255
    const { x, y } = resolveContextMenuPoint({
      clickX: props.targetEvent.clientX,
      clickY: props.targetEvent.clientY,
      menuWidth: menuWidthEstimate,
      menuHeight: menuHeightEstimate
    })
    menuPosition.value = { x, y }
  }
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
    :click-position="menuPosition"
    :column-data="columns"
    @update:model-value="onMenuVModelUpdate"
    @col-menu-handle-click="handleMenuItemClick"
  />
</template>

<style scoped>
/* This component is primarily a logic wrapper, so specific styles might not be needed here */
/* Styles for SongAreaColRightClickMenu are within that component itself */
</style>
