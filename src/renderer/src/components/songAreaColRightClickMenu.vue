<script setup>
import { watch, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidv4 } from 'uuid'
import tickIcon from '@renderer/assets/tickIcon.png'
const uuid = uuidv4()
const runtime = useRuntimeStore()

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
    type: Array,
    required: true
  },
  modelValue: {
    type: Boolean,
    required: true
  },
  clickEvent: {
    type: Object,
    required: true
  }
})

watch(
  () => props.modelValue,
  () => {
    if (props.modelValue == true) {
      runtime.activeMenuUUID = uuid
    }
  }
)
const menuButtonClick = (item) => {
  if (props.columnData.filter((col) => col.show).length == 1 && item.show) {
    return
  }
  emits('colMenuHandleClick', item)
}

let positionTop = ref(0)
let positionLeft = ref(0)
watch(
  () => props.clickEvent,
  () => {
    let windowWidth = window.innerWidth
    let windowHeight = window.innerHeight
    let clickX = props.clickEvent.clientX
    let clickY = props.clickEvent.clientY
    positionLeft.value = clickX
    positionTop.value = clickY
    let divHeight = props.columnData.length * 40
    let divWidth = 255
    if (clickY + divHeight > windowHeight) {
      positionTop.value = clickY - (clickY + divHeight - windowHeight)
    }
    if (clickX + divWidth > windowWidth) {
      positionLeft.value = clickX - (clickX + divWidth - windowWidth)
    }
  }
)
</script>
<template>
  <div
    v-if="props.modelValue"
    class="menu unselectable"
    :style="{ top: positionTop + 'px', left: positionLeft + 'px' }"
    @click.stop="() => {}"
  >
    <div v-for="item of props.columnData" class="menuGroup">
      <div class="menuButton" @click="menuButtonClick(item)" @contextmenu="menuButtonClick(item)">
        <div
          style="
            width: 19px;
            height: 19px;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <img v-if="item.show" :src="tickIcon" style="width: 16px" />
        </div>
        <div style="margin-left: 10px">
          <span>{{ item.columnName }}</span>
        </div>
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
      padding: 5px 20px;
      border-radius: 5px;

      &:hover {
        background-color: #0078d4;
        color: white;
      }
    }
  }

  .menuGroup:last-child {
    border-bottom: 0px;
  }
}
</style>
