<script setup>
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
const runtime = useRuntimeStore()
const props = defineProps({
  title: {
    type: String
  },
  content: {
    type: Array
  },
  confirmShow: {
    type: Boolean,
    default: true
  },
  textAlign: {
    type: String,
    default: 'center'
  },
  innerHeight: {
    type: Number,
    default: 180
  },
  innerWidth: {
    type: Number,
    default: 300
  },
  confirmHotkey: {
    type: String,
    default: '↵'
  },
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  }
})
const emits = defineEmits(['confirm', 'cancel'])
const confirm = () => {
  emits('confirm')
  if (props.confirmCallback) {
    props.confirmCallback()
  }
}
const cancel = () => {
  emits('cancel')
  if (props.cancelCallback) {
    props.cancelCallback()
  }
}

onMounted(() => {
  hotkeys(props.confirmHotkey === '↵' ? 'enter' : props.confirmHotkey, 'confirmDialog', () => {
    if (props.confirmShow) {
      confirm()
    }
  })

  hotkeys('Esc', 'confirmDialog', () => {
    cancel()
  })
  hotkeys.setScope('confirmDialog')
})
runtime.confirmShow = true
onUnmounted(() => {
  hotkeys.deleteScope('confirmDialog')
  runtime.confirmShow = false
})
</script>
<template>
  <div class="dialog unselectable" style="position: absolute; font-size: 14px">
    <div
      style="display: flex; flex-direction: column; justify-content: space-between"
      class="inner"
      :style="'height:' + innerHeight + 'px;' + 'width:' + innerWidth + 'px;'"
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ props.title }}</span>
        </div>
        <div style="padding-left: 20px; padding-right: 20px">
          <div
            v-for="item of props.content"
            style="margin-top: 10px"
            :style="'text-align:' + textAlign"
          >
            <span>{{ item }}</span>
          </div>
        </div>
      </div>
      <div v-if="confirmShow" style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 60px; text-align: center"
          @click="confirm()"
        >
          确定 {{ props.confirmHotkey }}
        </div>
        <div class="button" style="width: 60px; text-align: center" @click="cancel()">取消 Esc</div>
      </div>
      <div v-if="!confirmShow" style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" @click="cancel()">关闭 Esc</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped></style>
