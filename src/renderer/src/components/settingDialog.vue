<script setup>
import { ref, onUnmounted, onMounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidv4 } from 'uuid'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
const runtime = useRuntimeStore()
const uuid = uuidv4()
const emits = defineEmits(['cancel'])
const cancel = () => {
  emits('cancel')
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(runtime.hotkeysScopesHeap, uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(runtime.hotkeysScopesHeap, uuid)
})
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 60vw;
        height: 70vh;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
    >
      <div style="height: 100%; display: flex; flex-direction: column">
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">设置</span>
        </div>
        <div style="padding: 20px; font-size: 14px; flex-grow: 1; overflow-y: scroll">
          <div>语言：</div>
          <!-- todo -->
        </div>
        <div style="display: flex; justify-content: center; padding-bottom: 10px; height: 30px">
          <div class="button" @click="cancel()">关闭 Esc</div>
        </div>
      </div>
    </div>
  </div>
</template>
