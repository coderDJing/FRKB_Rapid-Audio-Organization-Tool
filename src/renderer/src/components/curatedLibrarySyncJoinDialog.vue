<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'
import type { CuratedLibrarySyncJoinMode } from '../../../shared/curatedLibrarySync'

const uuid = uuidV4()
const emits = defineEmits<{
  choose: [mode: CuratedLibrarySyncJoinMode]
  cancel: []
}>()
const props = defineProps<{
  title: string
  intro: string
  localCountLabel: string
  cloudCountLabel: string
  localCount: number
  cloudCount: number
  countUnit: string
  mergeLabel: string
  mergeHint: string
  mergeBadge: string
  cloudWinsLabel: string
  cloudWinsHint: string
  localWinsLabel: string
  localWinsHint: string
  cancelLabel: string
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const pendingMode = ref<CuratedLibrarySyncJoinMode | null>(null)

const options: Array<{
  mode: CuratedLibrarySyncJoinMode
  recommended: boolean
  label: () => string
  hint: () => string
}> = [
  {
    mode: 'merge',
    recommended: true,
    label: () => props.mergeLabel,
    hint: () => props.mergeHint
  },
  {
    mode: 'cloud-wins',
    recommended: false,
    label: () => props.cloudWinsLabel,
    hint: () => props.cloudWinsHint
  },
  {
    mode: 'local-wins',
    recommended: false,
    label: () => props.localWinsLabel,
    hint: () => props.localWinsHint
  }
]

const pendingOption = computed(
  () => options.find((item) => item.mode === pendingMode.value) || null
)

const pendingDangerous = computed(
  () => pendingMode.value === 'cloud-wins' || pendingMode.value === 'local-wins'
)

const confirmLines = computed(() => {
  const mode = pendingMode.value
  if (!mode) return []
  const local = props.localCount
  const cloud = props.cloudCount
  const lines = [
    t('cloudSync.curatedLibrary.joinConfirmSelected', {
      action: pendingOption.value?.label() || ''
    })
  ]
  if (mode === 'merge') {
    lines.push(t('cloudSync.curatedLibrary.joinConfirmMergeBody', { local, cloud }))
  } else if (mode === 'cloud-wins') {
    lines.push(t('cloudSync.curatedLibrary.joinConfirmCloudBody', { local, cloud }))
    if (cloud === 0 && local > 0) {
      lines.push(t('cloudSync.curatedLibrary.joinConfirmCloudEmpty'))
    }
  } else {
    lines.push(t('cloudSync.curatedLibrary.joinConfirmLocalBody', { local, cloud }))
    if (cloud > 0 && (local === 0 || local * 2 < cloud)) {
      lines.push(t('cloudSync.curatedLibrary.joinConfirmLocalFewer'))
    }
  }
  lines.push(t('cloudSync.curatedLibrary.joinConfirmIrreversible'))
  return lines
})

const requestChoose = (mode: CuratedLibrarySyncJoinMode) => {
  pendingMode.value = mode
}

const backToChoose = () => {
  pendingMode.value = null
}

const confirmPending = () => {
  const mode = pendingMode.value
  if (!mode) return
  closeWithAnimation(() => emits('choose', mode))
}

const cancel = () => {
  if (pendingMode.value) {
    pendingMode.value = null
    return
  }
  closeWithAnimation(() => emits('cancel'))
}

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
    style="font-size: 14px; z-index: var(--z-dialog-raised)"
  >
    <div v-dialog-drag="'.dialog-title'" class="inner join-dialog">
      <div class="dialog-title dialog-header">
        <span>{{
          pendingMode ? t('cloudSync.curatedLibrary.joinConfirmTitle') : props.title
        }}</span>
      </div>
      <div class="join-dialog__body">
        <template v-if="!pendingMode">
          <p class="join-dialog__intro">{{ props.intro }}</p>
          <div class="join-dialog__counts">
            <div class="join-dialog__count">
              <span class="join-dialog__count-label">{{ props.localCountLabel }}</span>
              <span class="join-dialog__count-value">
                {{ props.localCount }} {{ props.countUnit }}
              </span>
            </div>
            <div class="join-dialog__count">
              <span class="join-dialog__count-label">{{ props.cloudCountLabel }}</span>
              <span class="join-dialog__count-value">
                {{ props.cloudCount }} {{ props.countUnit }}
              </span>
            </div>
          </div>
          <div class="join-dialog__options">
            <div
              v-for="item in options"
              :key="item.mode"
              class="join-dialog__option"
              :class="{ 'join-dialog__option--recommended': item.recommended }"
              @click="requestChoose(item.mode)"
            >
              <div class="join-dialog__option-head">
                <span class="join-dialog__option-title">{{ item.label() }}</span>
                <span v-if="item.recommended" class="join-dialog__badge">{{
                  props.mergeBadge
                }}</span>
              </div>
              <span class="join-dialog__option-hint">{{ item.hint() }}</span>
            </div>
          </div>
        </template>
        <div
          v-else
          class="join-dialog__confirm"
          :class="{ 'join-dialog__confirm--danger': pendingDangerous }"
        >
          <p class="join-dialog__confirm-warn">
            {{ t('cloudSync.curatedLibrary.joinConfirmWarn') }}
          </p>
          <p v-for="(line, index) in confirmLines" :key="index" class="join-dialog__confirm-line">
            {{ line }}
          </p>
        </div>
      </div>
      <div class="dialog-footer join-dialog__footer">
        <template v-if="pendingMode">
          <div class="button join-dialog__cancel" @click="backToChoose()">
            {{ t('cloudSync.curatedLibrary.joinConfirmBack') }} (Esc)
          </div>
          <div
            class="button join-dialog__submit"
            :class="{ 'join-dialog__submit--danger': pendingDangerous }"
            @click="confirmPending()"
          >
            {{ t('cloudSync.curatedLibrary.joinConfirmSubmit') }}
          </div>
        </template>
        <div v-else class="button join-dialog__cancel" @click="cancel()">
          {{ props.cancelLabel }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.join-dialog {
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: calc(100vw - 24px);
  max-height: 70vh;
}

.join-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 16px 18px 8px;
  box-sizing: border-box;
}

.join-dialog__intro {
  margin: 0 0 12px;
  text-align: left;
  color: var(--text);
  line-height: 1.5;
}

.join-dialog__counts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.join-dialog__count {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
}

.join-dialog__count-label {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.join-dialog__count-value {
  color: var(--text);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
}

.join-dialog__options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.join-dialog__option {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.join-dialog__option:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.join-dialog__option--recommended {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
}

.join-dialog__option--recommended:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.join-dialog__option-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.join-dialog__option-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.join-dialog__badge {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 3px;
  background: var(--accent);
  color: #ffffff;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}

.join-dialog__option-hint {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
}

.join-dialog__confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
  text-align: left;
}

.join-dialog__confirm--danger {
  border-color: color-mix(in srgb, var(--error, #f56c6c) 48%, var(--border));
  background: color-mix(in srgb, var(--error, #f56c6c) 9%, var(--bg));
}

.join-dialog__confirm-warn {
  margin: 0;
  color: var(--error, #f56c6c);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.join-dialog__confirm-line {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
}

.join-dialog__footer {
  justify-content: center;
  gap: 10px;
}

.join-dialog__cancel,
.join-dialog__submit {
  min-width: 110px;
  width: fit-content;
  text-align: center;
}

.join-dialog__submit--danger {
  border: 1px solid color-mix(in srgb, var(--error, #f56c6c) 55%, var(--border));
  color: var(--error, #f56c6c);
}

.join-dialog__submit--danger:hover {
  color: #ffffff;
  background-color: var(--error, #f56c6c);
}
</style>
