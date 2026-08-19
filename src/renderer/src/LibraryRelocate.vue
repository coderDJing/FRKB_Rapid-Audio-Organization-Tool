<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'

type RelocatePhase =
  | 'prompt'
  | 'abort-only'
  | 'preparing'
  | 'copying'
  | 'renaming'
  | 'verifying'
  | 'switching'
  | 'deleting-source'
  | 'cleanup'
  | 'completed'
  | 'failed'
  | 'source-cleanup-failed'

type RelocateProgress = {
  phase: RelocatePhase
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  currentPath: string
  sameVolume: boolean
  sourcePath: string
  destPath: string
  errorCode?: string
  errorMessage?: string
  leftoverSourcePath?: string
  canCancel: boolean
}

const progress = ref<RelocateProgress | null>(null)
const busy = ref(false)

const phase = computed(() => progress.value?.phase || 'preparing')
const percent = computed(() => {
  const total = progress.value?.totalBytes || 0
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((progress.value?.copiedBytes || 0) / total) * 100)))
})
const percentText = computed(() => `${percent.value}%`)
const sizeText = computed(() => {
  const copied = progress.value?.copiedBytes || 0
  const total = progress.value?.totalBytes || 0
  if (total <= 0) return ''
  return `${formatBytes(copied)} / ${formatBytes(total)}`
})
const phaseI18nKey = computed(() => {
  if (phase.value === 'abort-only') return 'abortOnly'
  if (phase.value === 'deleting-source') return 'deletingSource'
  if (phase.value === 'source-cleanup-failed') return 'sourceCleanupFailed'
  return phase.value
})
const phaseTitle = computed(() => t(`migration.movePhase.${phaseI18nKey.value}`))
const errorText = computed(() => {
  const code = progress.value?.errorCode
  if (!code) return progress.value?.errorMessage || ''
  const key = `migration.moveDialog.issues.${code}`
  const translated = t(key)
  return translated === key ? progress.value?.errorMessage || '' : translated
})
const showProgressBar = computed(() =>
  [
    'copying',
    'renaming',
    'verifying',
    'switching',
    'deleting-source',
    'cleanup',
    'preparing'
  ].includes(phase.value)
)
const showCancel = computed(() => progress.value?.canCancel === true)
const showPromptActions = computed(() => phase.value === 'prompt')
const showAbortOnly = computed(() => phase.value === 'abort-only')
const showFailedActions = computed(() => phase.value === 'failed')
const showEnterLibrary = computed(() => phase.value === 'source-cleanup-failed')

const formatBytes = (value: number) => {
  const bytes = Math.max(0, Number(value) || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let result = bytes
  while (result >= 1024 && index < units.length - 1) {
    result /= 1024
    index += 1
  }
  const precision = index === 0 || result >= 100 ? 0 : 1
  return `${result.toFixed(precision)} ${units[index]}`
}

const applyProgress = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  progress.value = payload as RelocateProgress
}

const invokeAction = async (channel: string) => {
  if (busy.value) return
  busy.value = true
  try {
    await window.electron.ipcRenderer.invoke(channel)
  } finally {
    busy.value = false
  }
}

const handleProgress = (_event: unknown, payload: unknown) => {
  applyProgress(payload)
}

onMounted(async () => {
  window.electron.ipcRenderer.on('library-relocate:progress', handleProgress)
  const state = await window.electron.ipcRenderer.invoke('library-relocate:get-state')
  if (state?.progress) applyProgress(state.progress)
})

onBeforeUnmount(() => {
  window.electron.ipcRenderer.removeListener('library-relocate:progress', handleProgress)
})
</script>

<template>
  <div class="relocate-root unselectable">
    <div class="relocate-titlebar canDrag">
      <span class="title unselectable">{{ t('migration.moveDialog.title') }}</span>
    </div>
    <div class="relocate-body">
      <div class="relocate-status">{{ phaseTitle }}</div>

      <div v-if="showPromptActions" class="relocate-hint">{{ t('migration.moveHint.prompt') }}</div>
      <div v-else-if="showAbortOnly" class="relocate-hint">
        {{ t('migration.moveHint.abortOnly') }}
      </div>
      <div v-else class="relocate-hint">{{ t('migration.moveHint.locked') }}</div>

      <div v-if="progress?.sourcePath" class="relocate-path">
        {{ t('migration.moveDialog.currentPath', { path: progress.sourcePath }) }}
      </div>
      <div v-if="progress?.destPath" class="relocate-path">
        {{ t('migration.moveDialog.newPath', { path: progress.destPath }) }}
      </div>

      <div
        v-if="showProgressBar"
        class="relocate-progress"
        role="progressbar"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="relocate-progress-fill" :style="{ width: `${percent}%` }" />
      </div>
      <div v-if="showProgressBar" class="relocate-percent">
        {{ percentText }}
        <span v-if="sizeText"> · {{ sizeText }}</span>
      </div>
      <bubbleBoxTrigger
        v-if="progress?.currentPath"
        class="relocate-current"
        tag="div"
        :title="progress.currentPath"
        :only-when-overflow="true"
      >
        {{ progress.currentPath }}
      </bubbleBoxTrigger>

      <div v-if="errorText" class="relocate-error">{{ errorText }}</div>
      <div v-if="progress?.leftoverSourcePath" class="relocate-path">
        {{ t('migration.moveHint.sourceCleanupFailed') }}
        {{ progress.leftoverSourcePath }}
      </div>

      <div class="relocate-actions canNotDrag">
        <div
          v-if="showPromptActions"
          class="button"
          @click="invokeAction('library-relocate:continue')"
        >
          {{ t('migration.moveHint.continue') }}
        </div>
        <div
          v-if="showPromptActions || showAbortOnly || showFailedActions"
          class="button"
          @click="invokeAction('library-relocate:abort')"
        >
          {{ t('migration.moveHint.abort') }}
        </div>
        <div
          v-if="showFailedActions"
          class="button"
          @click="invokeAction('library-relocate:retry')"
        >
          {{ t('migration.moveHint.retry') }}
        </div>
        <div v-if="showCancel" class="button" @click="invokeAction('library-relocate:cancel')">
          {{ t('common.cancel') }}
        </div>
        <div
          v-if="showEnterLibrary"
          class="button"
          @click="invokeAction('library-relocate:enter-library')"
        >
          {{ t('migration.moveHint.enterLibrary') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
html,
body {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

#app {
  color: var(--text);
  background-color: var(--bg);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

body {
  margin: 0px;
  background-color: var(--bg);
}
</style>

<style scoped>
.relocate-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text);
  background: var(--bg);
}

.relocate-titlebar {
  flex-shrink: 0;
  height: 30px;
  line-height: 30px;
  text-align: center;
  font-size: 15px;
}

.relocate-titlebar .title {
  font-weight: bold;
}

.relocate-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: 12px 20px 18px;
}

.relocate-status {
  color: var(--accent);
}

.relocate-hint,
.relocate-path,
.relocate-percent,
.relocate-current,
.relocate-error {
  margin-top: 10px;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.relocate-current {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relocate-error {
  color: var(--danger, #dc3545);
}

.relocate-progress {
  height: 8px;
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
}

.relocate-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 180ms ease-out;
}

.relocate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 18px;
}

.relocate-actions .button {
  min-width: 88px;
  text-align: center;
}
</style>
