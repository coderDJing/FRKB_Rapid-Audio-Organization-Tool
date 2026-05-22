<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted, computed } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
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

const confirmDialogScrollOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  },
  overflow: {
    x: 'hidden' as const,
    y: 'scroll' as const
  }
}

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
      <OverlayScrollbarsComponent
        class="confirm-dialog__scroll-shell"
        element="div"
        :options="confirmDialogScrollOptions"
        defer
      >
        <div class="confirm-dialog__scroll-content" :class="{ selectable: canCopyText }">
          <div
            v-for="(item, index) of props.content"
            :key="index"
            class="confirm-dialog__scroll-line"
            :style="'text-align:' + textAlign"
          >
            <span>{{ item }}</span>
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div v-if="confirmShow" class="dialog-footer">
        <div class="button confirm-dialog__button" @click="confirm()">{{ confirmLabel }} (E)</div>
        <div class="button confirm-dialog__button" @click="cancel()">{{ cancelLabel }} (Esc)</div>
      </div>
      <div v-if="!confirmShow" class="dialog-footer">
        <div class="button confirm-dialog__button" @click="cancel()">
          {{ t('common.close') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dialog-footer {
  justify-content: center;
  flex-wrap: wrap;
}

.confirm-dialog__scroll-shell {
  flex: 1 1 auto;
  min-height: 0;
}

.confirm-dialog__scroll-content {
  padding: 10px 20px 20px;
  box-sizing: border-box;
}

.confirm-dialog__scroll-line {
  margin-top: 10px;
}

.confirm-dialog__button {
  min-width: 132px;
  padding: 0 14px;
  box-sizing: border-box;
  text-align: center;
  white-space: nowrap;
}
</style>
