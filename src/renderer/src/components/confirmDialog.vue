<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted } from 'vue'
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
  hotkeys('E', uuid, () => {
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
      :style="'height:' + innerHeight + 'px;' + 'width:' + innerWidth + 'px;'"
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ t(props.title) }}</span>
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
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirm()"
        >
          {{ t('确定') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('取消') }} (Esc)
        </div>
      </div>
      <div v-if="!confirmShow" style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" @click="cancel()">{{ t('关闭') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped></style>
