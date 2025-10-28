<script setup lang="ts">
import { watch, ref, onUnmounted, onMounted, PropType, nextTick } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
import { IMenu } from '../../../types/globals'

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

watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      props.cancelCallback()
    }
  }
)

let positionTop = ref(0)
let positionLeft = ref(0)

positionTop.value = -9999
positionLeft.value = -9999

const menuButtonClick = (item: IMenu) => {
  runtime.activeMenuUUID = ''
  props.confirmCallback(item)
}
const hoverItem = ref<IMenu | null>(null)
const mouseover = (item: IMenu) => {
  hoverItem.value = item
}
const mouseleave = () => {
  hoverItem.value = null
}
onMounted(() => {
  nextTick(() => {
    if (!menuRef.value) return

    const menuElement = menuRef.value
    const divHeight = menuElement.offsetHeight
    const divWidth = menuElement.offsetWidth

    let windowWidth = window.innerWidth
    let windowHeight = window.innerHeight
    let clickX = props.clickEvent.clientX
    let clickY = props.clickEvent.clientY

    let finalTop = clickY
    let finalLeft = clickX

    if (clickY + divHeight > windowHeight) {
      finalTop = clickY - divHeight
      if (finalTop < 0) {
        finalTop = 0
      }
    }

    if (clickX + divWidth > windowWidth) {
      finalLeft = clickX - divWidth
      if (finalLeft < 0) {
        finalLeft = 0
      }
    }

    positionTop.value = finalTop
    positionLeft.value = finalLeft
  })

  hotkeys('w', uuid, () => {
    let menuArr = props.menuArr.flat(1)
    if (hoverItem.value === null || menuArr.indexOf(hoverItem.value) === 0) {
      hoverItem.value = menuArr[menuArr.length - 1]
    } else {
      hoverItem.value = menuArr[menuArr.indexOf(hoverItem.value) - 1]
    }
    return false
  })
  hotkeys('s', uuid, () => {
    let menuArr = props.menuArr.flat(1)
    if (hoverItem.value === null || menuArr.indexOf(hoverItem.value) === menuArr.length - 1) {
      hoverItem.value = menuArr[0]
    } else {
      hoverItem.value = menuArr[menuArr.indexOf(hoverItem.value) + 1]
    }
    return false
  })
  hotkeys('E,Enter', uuid, () => {
    runtime.activeMenuUUID = ''
    props.confirmCallback(hoverItem.value)
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>
<template>
  <div
    ref="menuRef"
    class="menu unselectable"
    :style="{ top: positionTop + 'px', left: positionLeft + 'px' }"
    @click.stop="() => {}"
    @mouseleave.stop="mouseleave()"
  >
    <div v-for="item of props.menuArr" class="menuGroup">
      <div
        v-for="button of item"
        class="menuButton"
        @click="menuButtonClick(button)"
        :class="{
          menuButtonOver: hoverItem === null ? false : hoverItem.menuName === button.menuName
        }"
        @mouseover.stop="mouseover(button)"
        @contextmenu="menuButtonClick(button)"
      >
        <span>{{ t(button.menuName) }}</span>
        <span>{{ button.shortcutKey }}</span>
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
  width: 250px;
  border-radius: 5px;
  z-index: 10060; // 高于 .dialog(9999) 与 .frkb-bubble(10050) 与封面弹框(10010)

  .menuGroup {
    border-bottom: 1px solid var(--border);
    padding: 5px 5px;

    .menuButton {
      display: flex;
      justify-content: space-between;
      padding: 5px 20px;
      border-radius: 5px;
      color: var(--text);

      &:hover {
        background-color: var(--accent);
        color: #ffffff;
      }
    }

    .menuButtonOver {
      background-color: var(--accent);
      color: #ffffff;
    }
  }

  .menuGroup:last-child {
    border-bottom: 0;
  }
}
</style>
