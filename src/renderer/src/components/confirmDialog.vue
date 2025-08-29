<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted, computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'

const uuid = uuidV4()
const runtime = useRuntimeStore()
const props = defineProps({
  title: {
    type: String,
    default: ''
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
    default: 220
  },
  innerWidth: {
    type: Number,
    default: 400
  },
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  },
  canCopyText: {
    type: Boolean,
    default: false
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

// 计算容器样式：
// - 当传入 innerHeight 且 > 0 时，使用固定高度
// - 否则根据内容自适应，并限制最大高度避免溢出屏幕
const innerStyle = computed(() => {
  const heightPart =
    props.innerHeight && props.innerHeight > 0
      ? `height:${props.innerHeight}px;`
      : 'max-height:70vh;'
  return `${heightPart}width:${props.innerWidth}px;`
})

onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    if (props.confirmShow) {
      confirm()
    }
  })

  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})
runtime.confirmShow = true
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.confirmShow = false
})
</script>
<template>
  <div class="dialog unselectable" style="position: absolute; font-size: 14px">
    <div
      style="display: flex; flex-direction: column; justify-content: space-between"
      class="inner"
      :style="innerStyle"
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ props.title }}</span>
        </div>
        <div
          style="padding-left: 20px; padding-right: 20px; overflow-y: auto; flex: 1 1 auto"
          :class="{ selectable: canCopyText }"
        >
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
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
      <div v-if="!confirmShow" style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" @click="cancel()">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped></style>
