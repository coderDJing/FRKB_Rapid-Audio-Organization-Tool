<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted, computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

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
  confirmText: {
    type: String,
    default: ''
  },
  cancelText: {
    type: String,
    default: ''
  },
  canCopyText: {
    type: Boolean,
    default: false
  }
})
const emits = defineEmits(['confirm', 'cancel'])
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const confirm = () => {
  closeWithAnimation(() => {
    emits('confirm')
    props.confirmCallback?.()
  })
}
const cancel = () => {
  closeWithAnimation(() => {
    emits('cancel')
    props.cancelCallback?.()
  })
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

const confirmLabel = computed(() =>
  props.confirmText && props.confirmText.trim() !== '' ? props.confirmText : t('common.confirm')
)

const cancelLabel = computed(() =>
  props.cancelText && props.cancelText.trim() !== '' ? props.cancelText : t('common.cancel')
)

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
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px"
  >
    <div
      v-dialog-drag="'.dialog-title'"
      style="display: flex; flex-direction: column"
      class="inner"
      :style="innerStyle"
    >
      <div class="dialog-title dialog-header">
        <span>{{ props.title }}</span>
      </div>
      <div
        style="padding: 10px 20px 20px; overflow-y: auto; flex: 1 1 auto"
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
      <div v-if="confirmShow" class="dialog-footer">
        <div class="button" style="width: 90px; text-align: center" @click="confirm()">
          {{ confirmLabel }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ cancelLabel }} (Esc)
        </div>
      </div>
      <div v-if="!confirmShow" class="dialog-footer">
        <div class="button" @click="cancel()">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dialog-footer {
  justify-content: center;
}
</style>
