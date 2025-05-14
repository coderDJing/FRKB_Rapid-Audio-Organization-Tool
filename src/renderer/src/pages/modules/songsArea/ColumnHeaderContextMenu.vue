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
    const absoluteX = event.clientX
    const absoluteY = event.clientY

    // Estimate menu dimensions (copied from original songsArea.vue logic)
    // Consider making these props or dynamic if menu content changes significantly
    const menuHeightEstimate = props.columns.length * 40 // Rough estimate
    const menuWidthEstimate = 255 // Rough estimate

    let adjustedAbsoluteX = absoluteX
    let adjustedAbsoluteY = absoluteY

    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    if (absoluteY + menuHeightEstimate > windowHeight) {
      adjustedAbsoluteY = absoluteY - (absoluteY + menuHeightEstimate - windowHeight)
    }
    if (absoluteX + menuWidthEstimate > windowWidth) {
      adjustedAbsoluteX = absoluteX - (absoluteX + menuWidthEstimate - windowWidth)
    }

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
    menuPosition.value = { x: props.targetEvent.clientX, y: props.targetEvent.clientY }
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
    :modelValue="internalShow"
    @update:modelValue="onMenuVModelUpdate"
    :clickPosition="menuPosition"
    :columnData="columns"
    @colMenuHandleClick="handleMenuItemClick"
  />
</template>

<style scoped>
/* This component is primarily a logic wrapper, so specific styles might not be needed here */
/* Styles for SongAreaColRightClickMenu are within that component itself */
</style>
