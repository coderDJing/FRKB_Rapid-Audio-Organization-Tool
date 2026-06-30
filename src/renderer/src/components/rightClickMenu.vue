<script setup lang="ts">
import { watch, ref, onUnmounted, onMounted, PropType, nextTick } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
import { IMenu } from '../../../types/globals'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'
import bubbleBox from './bubbleBox.vue'

const uuid = uuidV4()
const runtime = useRuntimeStore()
runtime.activeMenuUUID = uuid

const props = defineProps({
  menuArr: {
    type: Array as PropType<IMenu[][]>,
    required: true
  },
  clickEvent: {
    type: Object,
    required: true
  },
  confirmCallback: {
    type: Function,
    required: true
  },
  cancelCallback: {
    type: Function,
    required: true
  }
})

const menuRef = ref<HTMLDivElement | null>(null)
const isVisible = ref(true)
const isClosing = ref(false)
const closeResult = ref<IMenu | 'cancel'>('cancel')
const menuButtonRefs = ref<Record<string, HTMLElement | null>>({})

const requestClose = (result: IMenu | 'cancel') => {
  if (isClosing.value) return
  isClosing.value = true
  closeResult.value = result
  if (runtime.activeMenuUUID === uuid) {
    runtime.activeMenuUUID = ''
  }
  isVisible.value = false
}

watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      requestClose('cancel')
    }
  }
)

const handleAfterLeave = () => {
  if (closeResult.value === 'cancel') {
    props.cancelCallback()
    return
  }
  props.confirmCallback(closeResult.value)
}

let positionTop = ref(0)
let positionLeft = ref(0)
let openSubmenuLeft = ref(false)

positionTop.value = -9999
positionLeft.value = -9999

const hoverItem = ref<IMenu | null>(null)
const getMenuItemRefKey = (item: IMenu) => item.menuName
const setMenuItemRef = (item: IMenu, element: Element | ComponentPublicInstance | null) => {
  const key = getMenuItemRefKey(item)
  if (element instanceof HTMLElement) {
    menuButtonRefs.value[key] = element
    return
  }
  menuButtonRefs.value[key] = null
}
const resolveDisabledReason = (item: IMenu) => {
  if (item.disabledReasonKey) return t(item.disabledReasonKey)
  return item.disabledReason || ''
}
const resolveTrailingText = (item: IMenu) => {
  if (item.disabled) return t(item.disabledStatusKey || 'common.loading')
  return item.children?.length ? '>' : item.shortcutKey
}
const isMenuItemOver = (item: IMenu) => {
  if (hoverItem.value === null) return false
  return (
    hoverItem.value.menuName === item.menuName ||
    !!item.children?.some((child) => child.menuName === hoverItem.value?.menuName)
  )
}
const isMenuItemEnabled = (item: IMenu) => !item.disabled
const menuButtonClick = (item: IMenu) => {
  if (item.disabled) return
  if (item.children?.length) {
    hoverItem.value = item
    return
  }
  requestClose(item)
}
const mouseover = (item: IMenu) => {
  hoverItem.value = item
}
const mouseleave = () => {
  hoverItem.value = null
}
const handleGlobalPointerDown = (event: MouseEvent) => {
  if (!isVisible.value) return
  const target = event.target as Node | null
  if (menuRef.value && target && menuRef.value.contains(target)) return
  requestClose('cancel')
}
onMounted(() => {
  nextTick(() => {
    if (!menuRef.value) return

    const menuElement = menuRef.value
    const divHeight = menuElement.offsetHeight
    const divWidth = menuElement.offsetWidth

    const { x, y } = resolveContextMenuPoint({
      clickX: props.clickEvent.clientX,
      clickY: props.clickEvent.clientY,
      menuWidth: divWidth,
      menuHeight: divHeight
    })

    positionTop.value = y
    positionLeft.value = x
    openSubmenuLeft.value = x + divWidth + 230 > window.innerWidth - 8
  })

  const getNavigableItems = () =>
    props.menuArr
      .flat(1)
      .flatMap((item) => [item, ...(item.children || [])])
      .filter(isMenuItemEnabled)

  hotkeys('w', uuid, () => {
    let menuArr = getNavigableItems()
    if (menuArr.length === 0) return false
    const currentIndex = hoverItem.value === null ? -1 : menuArr.indexOf(hoverItem.value)
    if (currentIndex <= 0) {
      hoverItem.value = menuArr[menuArr.length - 1]
    } else {
      hoverItem.value = menuArr[currentIndex - 1]
    }
    return false
  })
  hotkeys('s', uuid, () => {
    let menuArr = getNavigableItems()
    if (menuArr.length === 0) return false
    const currentIndex = hoverItem.value === null ? -1 : menuArr.indexOf(hoverItem.value)
    if (currentIndex < 0 || currentIndex >= menuArr.length - 1) {
      hoverItem.value = menuArr[0]
    } else {
      hoverItem.value = menuArr[currentIndex + 1]
    }
    return false
  })
  hotkeys('E,Enter', uuid, () => {
    if (hoverItem.value === null) {
      const flattened = getNavigableItems()
      if (flattened.length === 0) return false
      hoverItem.value = flattened[0]
    }
    if (hoverItem.value && !hoverItem.value.disabled && !hoverItem.value.children?.length) {
      requestClose(hoverItem.value)
    }
  })
  utils.setHotkeysScpoe(uuid)
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
})
</script>
<template>
  <Transition name="context-menu" appear @after-leave="handleAfterLeave">
    <div
      v-if="isVisible"
      ref="menuRef"
      data-frkb-context-menu="true"
      class="menu unselectable"
      :style="{ top: positionTop + 'px', left: positionLeft + 'px' }"
      @click.stop="() => {}"
      @mouseleave.stop="mouseleave()"
    >
      <div v-for="item of props.menuArr" class="menuGroup">
        <div
          v-for="button of item"
          :ref="(el) => setMenuItemRef(button, el)"
          class="menuButton"
          :class="{
            menuButtonOver: isMenuItemOver(button),
            menuButtonDisabled: button.disabled
          }"
          :aria-disabled="button.disabled ? 'true' : 'false'"
          @click="menuButtonClick(button)"
          @mouseover.stop="mouseover(button)"
          @contextmenu.stop.prevent="menuButtonClick(button)"
        >
          <span>{{ t(button.menuName) }}</span>
          <span :class="{ menuButtonStatus: button.disabled }">{{
            resolveTrailingText(button)
          }}</span>
          <bubbleBox
            v-if="button.disabled && resolveDisabledReason(button)"
            :dom="menuButtonRefs[getMenuItemRefKey(button)] || undefined"
            :title="resolveDisabledReason(button)"
            :show-delay="250"
            :z-index="'calc(var(--z-context-menu) + 1)'"
          />
          <div
            v-if="
              button.children?.length &&
              !button.disabled &&
              hoverItem &&
              (hoverItem.menuName === button.menuName ||
                button.children.some((child) => child.menuName === hoverItem?.menuName))
            "
            class="submenu"
            :class="{ submenuLeft: openSubmenuLeft }"
            @click.stop="() => {}"
            @contextmenu.stop.prevent
          >
            <div
              v-for="child of button.children"
              :ref="(el) => setMenuItemRef(child, el)"
              class="submenuButton"
              :class="{
                menuButtonOver: hoverItem?.menuName === child.menuName,
                submenuButtonDisabled: child.disabled
              }"
              :aria-disabled="child.disabled ? 'true' : 'false'"
              @click.stop="menuButtonClick(child)"
              @mouseover.stop="mouseover(child)"
              @contextmenu.stop.prevent="menuButtonClick(child)"
            >
              <span>{{ t(child.menuName) }}</span>
              <span :class="{ menuButtonStatus: child.disabled }">{{
                resolveTrailingText(child)
              }}</span>
              <bubbleBox
                v-if="child.disabled && resolveDisabledReason(child)"
                :dom="menuButtonRefs[getMenuItemRefKey(child)] || undefined"
                :title="resolveDisabledReason(child)"
                :show-delay="250"
                :z-index="'calc(var(--z-context-menu) + 1)'"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
<style lang="scss" scoped>
.context-menu-enter-active,
.context-menu-leave-active {
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.context-menu-enter-from,
.context-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.menu {
  position: absolute;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 14px;
  min-width: 250px;
  width: max-content;
  max-width: calc(100vw - 12px);
  border-radius: 5px;
  z-index: var(--z-context-menu);

  .menuGroup {
    border-bottom: 1px solid var(--border);
    padding: 5px 5px;

    .menuButton {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 24px;
      padding: 5px 20px;
      border-radius: 5px;
      color: var(--text);

      &:hover {
        background-color: var(--accent);
        color: #ffffff;
      }
    }

    .menuButton > span {
      white-space: nowrap;
    }

    .menuButton > span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .menuButtonOver {
      background-color: var(--accent);
      color: #ffffff;
    }

    .menuButtonDisabled {
      color: var(--text-weak);
      cursor: default;
      opacity: 0.68;

      &:hover {
        background-color: transparent;
        color: var(--text-weak);
      }
    }

    .menuButtonStatus {
      font-size: 12px;
      color: inherit;
    }

    .submenu {
      position: absolute;
      top: -5px;
      left: 100%;
      min-width: 220px;
      width: max-content;
      max-width: calc(100vw - 12px);
      padding: 5px;
      background-color: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 5px;
      color: var(--text);
      z-index: 1;
    }

    .submenuLeft {
      left: auto;
      right: 100%;
    }

    .submenuButton {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 24px;
      padding: 5px 20px;
      border-radius: 5px;
      color: var(--text);

      &:hover {
        background-color: var(--accent);
        color: #ffffff;
      }
    }

    .submenuButton > span {
      white-space: nowrap;
    }

    .submenuButton > span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .submenuButtonDisabled {
      color: var(--text-weak);
      cursor: default;
      opacity: 0.68;

      &:hover {
        background-color: transparent;
        color: var(--text-weak);
      }
    }
  }

  .menuGroup:last-child {
    border-bottom: 0;
  }
}
</style>
