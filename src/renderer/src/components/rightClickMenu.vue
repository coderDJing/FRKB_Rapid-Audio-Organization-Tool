<script setup>
import { watch, ref, onUnmounted, onMounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidv4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
const uuid = uuidv4()
const runtime = useRuntimeStore()
runtime.activeMenuUUID = uuid
const props = defineProps({
  menuArr: {
    type: Array,
    required: true
  },
  clickEvent: {
    type: Object,
    required: true
  },
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  }
})
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
let windowWidth = window.innerWidth
let windowHeight = window.innerHeight
let clickX = props.clickEvent.clientX
let clickY = props.clickEvent.clientY
positionLeft.value = clickX
positionTop.value = clickY

let itemCount = 0
for (let arr of props.menuArr) {
  itemCount = itemCount + arr.length
}
let divHeight = props.menuArr.length * 10 + itemCount * 29 + (props.menuArr.length - 1) + 5
let divWidth = 255
if (clickY + divHeight > windowHeight) {
  positionTop.value = clickY - (clickY + divHeight - windowHeight)
}
if (clickX + divWidth > windowWidth) {
  positionLeft.value = clickX - (clickX + divWidth - windowWidth)
}
const menuButtonClick = (item) => {
  runtime.activeMenuUUID = ''
  props.confirmCallback(item)
}
const hoverItem = ref({})
const mouseover = (item) => {
  hoverItem.value = item
}
const mouseleave = () => {
  hoverItem.value = {}
}
onMounted(() => {
  hotkeys('w', uuid, () => {
    let menuArr = props.menuArr.flat(1)
    if (Object.keys(hoverItem.value).length === 0 || menuArr.indexOf(hoverItem.value) === 0) {
      hoverItem.value = menuArr[menuArr.length - 1]
    } else {
      hoverItem.value = menuArr[menuArr.indexOf(hoverItem.value) - 1]
    }
    return false
  })
  hotkeys('s', uuid, () => {
    let menuArr = props.menuArr.flat(1)
    if (
      Object.keys(hoverItem.value).length === 0 ||
      menuArr.indexOf(hoverItem.value) === menuArr.length - 1
    ) {
      hoverItem.value = menuArr[0]
    } else {
      hoverItem.value = menuArr[menuArr.indexOf(hoverItem.value) + 1]
    }
    return false
  })
  hotkeys('E', uuid, () => {
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
    class="menu unselectable"
    :style="{ top: positionTop + 'px', left: positionLeft + 'px' }"
    style="z-index: 99"
    @click.stop="() => {}"
    @mouseleave.stop="mouseleave()"
  >
    <div v-for="item of props.menuArr" class="menuGroup">
      <div
        v-for="button of item"
        class="menuButton"
        @click="menuButtonClick(button)"
        :class="{ menuButtonOver: hoverItem.menuName === button.menuName }"
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
  background-color: #1f1f1f;
  border: 1px solid #454545;
  font-size: 14px;
  width: 250px;
  border-radius: 5px;

  .menuGroup {
    border-bottom: 1px solid #454545;
    padding: 5px 5px;

    .menuButton {
      display: flex;
      justify-content: space-between;
      padding: 5px 20px;
      border-radius: 5px;
      color: #cccccc;

      // &:hover {
      //   background-color: #0078d4;
      //   color: white;
      // }
    }

    .menuButtonOver {
      background-color: #0078d4;
      color: white;
    }
  }

  .menuGroup:last-child {
    border-bottom: 0px;
  }
}
</style>
