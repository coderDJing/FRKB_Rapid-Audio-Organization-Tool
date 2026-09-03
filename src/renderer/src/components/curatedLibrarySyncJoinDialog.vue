<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import type { CuratedLibrarySyncJoinMode } from '../../../shared/curatedLibrarySync'

const uuid = uuidV4()
const emits = defineEmits<{
  choose: [mode: CuratedLibrarySyncJoinMode]
  cancel: []
}>()
const props = defineProps<{
  title: string
  lines: string[]
  mergeLabel: string
  cloudWinsLabel: string
  localWinsLabel: string
  cancelLabel: string
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const choose = (mode: CuratedLibrarySyncJoinMode) => {
  closeWithAnimation(() => emits('choose', mode))
}
const cancel = () => closeWithAnimation(() => emits('cancel'))

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>
<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px"
  >
    <div v-dialog-drag="'.dialog-title'" class="inner" style="width: 460px; height: 360px">
      <div class="dialog-title dialog-header">
        <span>{{ props.title }}</span>
      </div>
      <OverlayScrollbarsComponent
        class="join-dialog__scroll"
        element="div"
        :options="{
          scrollbars: { autoHide: 'leave', autoHideDelay: 50, clickScroll: true },
          overflow: { x: 'hidden', y: 'scroll' }
        }"
        defer
      >
        <div class="join-dialog__content">
          <div v-for="(line, index) in props.lines" :key="index" class="join-dialog__line">
            {{ line }}
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div class="dialog-footer join-dialog__footer">
        <div class="button join-dialog__button" @click="choose('merge')">
          {{ props.mergeLabel }}
        </div>
        <div class="button join-dialog__button" @click="choose('cloud-wins')">
          {{ props.cloudWinsLabel }}
        </div>
        <div class="button join-dialog__button" @click="choose('local-wins')">
          {{ props.localWinsLabel }}
        </div>
        <div class="button join-dialog__button" @click="cancel()">
          {{ props.cancelLabel }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.join-dialog__scroll {
  flex: 1 1 auto;
  min-height: 0;
}
.join-dialog__content {
  padding: 10px 20px 16px;
  box-sizing: border-box;
}
.join-dialog__line {
  margin-top: 10px;
  text-align: left;
  color: var(--text);
}
.join-dialog__footer {
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.join-dialog__button {
  min-width: 160px;
  padding: 0 12px;
  text-align: center;
}
</style>
