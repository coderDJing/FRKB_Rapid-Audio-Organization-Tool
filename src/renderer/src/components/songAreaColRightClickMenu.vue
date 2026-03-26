<script setup lang="ts">
import { watch, ref, PropType, onMounted, onUnmounted, nextTick } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import tickIconAsset from '@renderer/assets/tickIcon.svg?asset'
import { t } from '@renderer/utils/translate'
import { ISongsAreaColumn } from '../../../types/globals'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'
const uuid = uuidV4()
const runtime = useRuntimeStore()
const tickIcon = tickIconAsset
const menuRef = ref<HTMLDivElement | null>(null)

const emits = defineEmits(['update:modelValue', 'colMenuHandleClick'])
watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      emits('update:modelValue', false)
    }
  }
)
const props = defineProps({
  columnData: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  modelValue: {
    type: Boolean,
    required: true
  },
  clickEvent: {
    type: Object as PropType<MouseEvent | null>,
    default: null
  },
  scrollHostElement: {
    type: Object as PropType<HTMLElement | null | undefined>,
    default: null
  }
})

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      runtime.activeMenuUUID = uuid
      positionLeft.value = -9999
      positionTop.value = -9999
      void updateMenuPosition()
    }
  }
)
const menuButtonClick = (item: ISongsAreaColumn) => {
  if (props.columnData.filter((col) => col.show).length == 1 && item.show) {
    return
  }
  emits('colMenuHandleClick', item)
}

const closeMenu = () => {
  if (!props.modelValue) return
  if (runtime.activeMenuUUID === uuid) {
    runtime.activeMenuUUID = ''
  }
  emits('update:modelValue', false)
}

let positionTop = ref(-9999)
let positionLeft = ref(-9999)

const updateMenuPosition = async () => {
  if (!props.modelValue || !props.clickEvent) return

  await nextTick()
  if (!menuRef.value) return

  const { x, y } = resolveContextMenuPoint({
    clickX: props.clickEvent.clientX,
    clickY: props.clickEvent.clientY,
    menuWidth: menuRef.value.offsetWidth,
    menuHeight: menuRef.value.offsetHeight
  })

  if (props.scrollHostElement) {
    const hostRect = props.scrollHostElement.getBoundingClientRect()
    positionLeft.value = x - hostRect.left
    positionTop.value = Math.max(0, y - hostRect.top)
    return
  }

  positionLeft.value = x
  positionTop.value = y
}

watch(
  () => props.clickEvent,
  () => {
    if (props.modelValue) {
      void updateMenuPosition()
    }
  }
)

watch(
  () => props.scrollHostElement,
  () => {
    if (props.modelValue) {
      void updateMenuPosition()
    }
  }
)

const handleGlobalPointerDown = (event: PointerEvent) => {
  if (!props.modelValue) return
  const target = event.target as Node | null
  if (menuRef.value && target && menuRef.value.contains(target)) return
  closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
})
</script>
<template>
  <div
    v-if="props.modelValue"
    ref="menuRef"
    data-frkb-context-menu="true"
    class="menu unselectable"
    :style="{ top: positionTop + 'px', left: positionLeft + 'px' }"
    @click.stop="() => {}"
  >
    <div v-for="item of props.columnData" class="menuGroup">
      <div class="menuButton" @click="menuButtonClick(item)" @contextmenu="menuButtonClick(item)">
        <div class="menuButtonIcon">
          <img v-if="item.show" :src="tickIcon" style="width: 16px" class="theme-icon" />
        </div>
        <div class="menuButtonLabel">
          <span>{{ t(item.columnName) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.menu {
  position: absolute;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 14px;
  min-width: 250px;
  width: max-content;
  max-width: calc(100vw - 12px);
  border-radius: 5px;
  z-index: 10010; // 高于全局 .dialog(9999)

  .menuGroup {
    border-bottom: 1px solid var(--border);
    padding: 5px 5px;

    .menuButton {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px 20px;
      border-radius: 5px;
      white-space: nowrap;

      &:hover {
        background-color: var(--accent);
        color: #ffffff;
      }
    }

    .menuButtonIcon {
      width: 19px;
      height: 19px;
      flex: 0 0 19px;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .menuButtonLabel {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .menuButtonLabel span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .menuGroup:last-child {
    border-bottom: 0px;
  }
}
</style>
