<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'

type LibraryMergeMode = 'copy' | 'delete-source'
type LibraryMergePhase =
  | 'preflight'
  | 'staging'
  | 'promoting'
  | 'committing'
  | 'deleting-source'
  | 'completed'
  | 'failed'
type LibraryMergeStep = 'intro' | 'setup' | 'checking' | 'running' | 'completed' | 'failed'
type LibraryMergeProgress = {
  phase: LibraryMergePhase
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  currentPath?: string
}
type SourceCheckIssueKind =
  | 'invalid-selection'
  | 'same-library'
  | 'nested-library'
  | 'version-incompatible'
  | 'unregistered-data'
  | 'invalid-library'
  | 'insufficient-space'
  | 'space-unavailable'
  | 'current-library'
  | 'unavailable'
type SourceCheckIssue = {
  kind: SourceCheckIssueKind
}
type MergeResultSummary = {
  songListCount: number
  copiedFileCount: number
  sourceDeleteError: string
}

const emit = defineEmits<{
  close: []
}>()

const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const step = ref<LibraryMergeStep>('intro')
const mode = ref<LibraryMergeMode>('copy')
const sourceRoot = ref('')
const sourceChecked = ref(false)
const sourceCheckIssue = ref<SourceCheckIssue | null>(null)
const failureMessage = ref('')
const isSelectingSource = ref(false)
const progress = ref<LibraryMergeProgress>({
  phase: 'preflight',
  copiedBytes: 0,
  totalBytes: 0,
  copiedFiles: 0,
  totalFiles: 0
})
const resultSummary = ref<MergeResultSummary | null>(null)
const sourcePathRef = useTemplateRef<HTMLElement>('sourcePathRef')
const currentPathRef = useTemplateRef<HTMLElement>('currentPathRef')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const getNumber = (value: unknown): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

const isSuccessResponse = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.success === true

const getErrorMessage = (value: unknown): string => {
  if (!isRecord(value)) return t('common.unknownError')
  return getString(value.message) || t('common.unknownError')
}

const getErrorCode = (value: unknown): string =>
  isRecord(value) ? getString(value.code).toUpperCase() : ''

const getSourceCheckIssueKind = (value: unknown): SourceCheckIssueKind => {
  const code = getErrorCode(value)
  if (code === 'SOURCE_MANIFEST_INVALID') return 'invalid-selection'
  if (code === 'SOURCE_EQUALS_TARGET') return 'same-library'
  if (code === 'NESTED_LIBRARY_ROOT') return 'nested-library'
  if (code === 'SOURCE_VERSION_INCOMPATIBLE' || code === 'SOURCE_SCHEMA_UNSUPPORTED') {
    return 'version-incompatible'
  }
  if (code === 'SOURCE_METADATA_UNSUPPORTED') return 'unregistered-data'
  if (code === 'INSUFFICIENT_SPACE') return 'insufficient-space'
  if (code === 'CAPACITY_UNAVAILABLE') return 'space-unavailable'
  if (code === 'TARGET_NOT_READY' || code === 'TARGET_VERSION_INCOMPATIBLE') {
    return 'current-library'
  }
  if (
    [
      'SOURCE_DATABASE_CORRUPT',
      'SOURCE_TREE_INVALID',
      'SOURCE_FILE_UNSAFE',
      'SOURCE_DATA_INVALID',
      'SOURCE_ANALYSIS_INVALID'
    ].includes(code)
  ) {
    return 'invalid-library'
  }
  return 'unavailable'
}

const setSourceCheckIssue = (value: unknown) => {
  sourceChecked.value = false
  sourceCheckIssue.value = { kind: getSourceCheckIssueKind(value) }
}

const sourceCheckPassed = computed(
  () => step.value === 'setup' && sourceChecked.value && !sourceCheckIssue.value
)
const isWorking = computed(
  () => step.value === 'checking' || step.value === 'running' || isSelectingSource.value
)
const canStart = computed(
  () => step.value === 'setup' && sourceCheckPassed.value && !isWorking.value
)
const canClose = computed(() => !isWorking.value && step.value !== 'running')
const currentPath = computed(() => getString(progress.value.currentPath))
const hasKnownByteTotal = computed(() => progress.value.totalBytes > 0)
const progressPercent = computed(() => {
  if (!hasKnownByteTotal.value) return null
  const percent = (progress.value.copiedBytes / progress.value.totalBytes) * 100
  return Math.max(0, Math.min(100, percent))
})
const progressPercentText = computed(() =>
  progressPercent.value === null ? '' : `${Math.round(progressPercent.value)}%`
)
const phaseTitleKey = computed(() => `migration.mergePhase.${progress.value.phase}`)
const phaseDescriptionKey = computed(() => `migration.mergeDescription.${progress.value.phase}`)
const sourceCheckIssueTitleKey = computed(
  () => `migration.mergeDialog.sourceIssues.${sourceCheckIssue.value?.kind || 'unavailable'}.title`
)
const sourceCheckIssueDescriptionKey = computed(
  () =>
    `migration.mergeDialog.sourceIssues.${sourceCheckIssue.value?.kind || 'unavailable'}.description`
)

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

const close = () => {
  if (!canClose.value) return
  closeWithAnimation(() => emit('close'))
}

const openSetup = () => {
  if (isWorking.value) return
  step.value = 'setup'
  failureMessage.value = ''
}

const selectSource = async () => {
  if (isWorking.value) return
  isSelectingSource.value = true
  sourceCheckIssue.value = null
  try {
    const response: unknown = await window.electron.ipcRenderer.invoke(
      'library-merge:select-source'
    )
    if (!isSuccessResponse(response)) {
      sourceRoot.value = ''
      setSourceCheckIssue(response)
      return
    }
    const selectedRoot = getString(response.sourceRoot)
    if (!selectedRoot) return
    sourceRoot.value = selectedRoot
    sourceChecked.value = false
    step.value = 'checking'
    const inspected: unknown = await window.electron.ipcRenderer.invoke(
      'library-merge:inspect',
      selectedRoot
    )
    if (!isSuccessResponse(inspected)) {
      setSourceCheckIssue(inspected)
      step.value = 'setup'
      return
    }
    sourceChecked.value = true
    step.value = 'setup'
  } catch (error) {
    setSourceCheckIssue(error)
    step.value = 'setup'
  } finally {
    isSelectingSource.value = false
  }
}

const startMerge = async () => {
  if (!canStart.value) return
  failureMessage.value = ''
  resultSummary.value = null
  progress.value = {
    phase: 'preflight',
    copiedBytes: 0,
    totalBytes: 0,
    copiedFiles: 0,
    totalFiles: 0
  }
  step.value = 'running'
  try {
    const response: unknown = await window.electron.ipcRenderer.invoke('library-merge:start', {
      sourceRoot: sourceRoot.value,
      mode: mode.value
    })
    if (!isSuccessResponse(response) || !isRecord(response.result)) {
      failureMessage.value = getErrorMessage(response)
      step.value = 'failed'
      return
    }
    const result = response.result
    resultSummary.value = {
      songListCount: getNumber(result.songListCount),
      copiedFileCount: getNumber(result.copiedFileCount),
      sourceDeleteError: getString(result.sourceDeleteError)
    }
    step.value = 'completed'
  } catch (error) {
    failureMessage.value = error instanceof Error ? error.message : t('common.unknownError')
    step.value = 'failed'
  }
}

const returnToSetup = () => {
  if (isWorking.value) return
  failureMessage.value = ''
  step.value = 'setup'
}

const handleProgress = (_event: unknown, payload: unknown) => {
  if (!isRecord(payload)) return
  const phase = getString(payload.phase)
  const phases: LibraryMergePhase[] = [
    'preflight',
    'staging',
    'promoting',
    'committing',
    'deleting-source',
    'completed',
    'failed'
  ]
  if (!phases.includes(phase as LibraryMergePhase)) return
  progress.value = {
    phase: phase as LibraryMergePhase,
    copiedBytes: getNumber(payload.copiedBytes),
    totalBytes: getNumber(payload.totalBytes),
    copiedFiles: getNumber(payload.copiedFiles),
    totalFiles: getNumber(payload.totalFiles),
    ...(getString(payload.currentPath) ? { currentPath: getString(payload.currentPath) } : {})
  }
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    close()
    return false
  })
  hotkeys('Enter', uuid, () => {
    if (step.value === 'intro') openSetup()
    else if (canStart.value) void startMerge()
    return false
  })
  utils.setHotkeysScpoe(uuid)
  window.electron.ipcRenderer.on('library-merge:progress', handleProgress)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  window.electron.ipcRenderer.removeListener('library-merge:progress', handleProgress)
})
</script>

<template>
  <div
    class="dialog unselectable library-merge-dialog"
    :class="{ 'dialog-visible': dialogVisible }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="library-merge-dialog-title"
  >
    <section v-dialog-drag="'.dialog-title'" class="inner">
      <div id="library-merge-dialog-title" class="dialog-title dialog-header">
        {{ t('migration.mergeDialog.title') }}
      </div>
      <div class="library-merge-dialog__body">
        <template v-if="step === 'intro'">
          <p class="library-merge-dialog__lead">{{ t('migration.mergeDialog.intro') }}</p>
          <section class="library-merge-dialog__section">
            <h3>{{ t('migration.mergeDialog.contentsTitle') }}</h3>
            <p>{{ t('migration.mergeDialog.contents') }}</p>
          </section>
          <section class="library-merge-dialog__section">
            <h3>{{ t('migration.mergeDialog.safetyTitle') }}</h3>
            <p>{{ t('migration.mergeDialog.safety') }}</p>
          </section>
          <section class="library-merge-dialog__section">
            <h3>{{ t('migration.mergeDialog.playlistTitle') }}</h3>
            <p>{{ t('migration.mergeDialog.playlist') }}</p>
          </section>
        </template>

        <template v-else-if="step === 'setup' || step === 'checking'">
          <section class="library-merge-dialog__section">
            <h3>{{ t('migration.mergeDialog.sourceTitle') }}</h3>
            <p>{{ t('migration.mergeDialog.sourceInstruction') }}</p>
            <div class="library-merge-dialog__source-actions">
              <button
                class="button library-merge-dialog__button"
                :class="{ 'library-merge-dialog__button--disabled': isWorking }"
                type="button"
                :disabled="isWorking"
                @click="selectSource"
              >
                {{ t('migration.mergeDialog.selectSource') }}
              </button>
              <span v-if="sourceRoot" class="library-merge-dialog__source-selected">
                {{ t('migration.mergeDialog.sourceSelected') }}
              </span>
            </div>
            <div v-if="sourceRoot" ref="sourcePathRef" class="library-merge-dialog__path">
              {{ sourceRoot }}
            </div>
            <bubbleBox
              v-if="sourceRoot"
              :dom="sourcePathRef || undefined"
              :title="sourceRoot"
              :max-width="620"
            />
            <div
              v-if="step === 'checking'"
              class="library-merge-dialog__status library-merge-dialog__status--checking"
            >
              {{ t('migration.mergeDialog.checkingSource') }}
            </div>
            <div
              v-else-if="sourceRoot && !sourceCheckIssue"
              class="library-merge-dialog__status library-merge-dialog__status--success"
            >
              {{ t('migration.mergeDialog.sourceCheckPassed') }}
            </div>
            <div v-else-if="sourceCheckIssue" class="library-merge-dialog__source-issue">
              <div class="library-merge-dialog__source-issue-icon" aria-hidden="true">!</div>
              <div>
                <strong>{{ t(sourceCheckIssueTitleKey) }}</strong>
                <p>{{ t(sourceCheckIssueDescriptionKey) }}</p>
              </div>
            </div>
            <div v-else class="library-merge-dialog__status">
              {{ t('migration.mergeDialog.sourceRequired') }}
            </div>
          </section>

          <section class="library-merge-dialog__section">
            <h3>{{ t('migration.mergeDialog.modeTitle') }}</h3>
            <label class="library-merge-dialog__mode-option">
              <input v-model="mode" type="radio" value="copy" :disabled="isWorking" />
              <span>
                <strong>{{ t('migration.mergeDialog.copyMode') }}</strong>
                <small>{{ t('migration.mergeDialog.copyDescription') }}</small>
              </span>
            </label>
            <label class="library-merge-dialog__mode-option">
              <input v-model="mode" type="radio" value="delete-source" :disabled="isWorking" />
              <span>
                <strong>{{ t('migration.mergeDialog.deleteMode') }}</strong>
                <small>{{ t('migration.mergeDialog.deleteDescription') }}</small>
              </span>
            </label>
          </section>
        </template>

        <template v-else-if="step === 'running'">
          <div class="library-merge-dialog__progress-title">{{ t(phaseTitleKey) }}</div>
          <div class="library-merge-dialog__progress-description">{{ t(phaseDescriptionKey) }}</div>
          <div
            class="library-merge-dialog__progress-track"
            :class="{
              'library-merge-dialog__progress-track--indeterminate': progressPercent === null
            }"
          >
            <div
              v-if="progressPercent !== null"
              class="library-merge-dialog__progress-fill"
              :style="{ width: `${progressPercent}%` }"
            ></div>
          </div>
          <div class="library-merge-dialog__progress-stats">
            <span v-if="hasKnownByteTotal">
              {{ formatBytes(progress.copiedBytes) }} / {{ formatBytes(progress.totalBytes) }}
            </span>
            <span v-else>{{ t('migration.mergePreparing') }}</span>
            <span v-if="progressPercent !== null">{{ progressPercentText }}</span>
          </div>
          <div class="library-merge-dialog__file-stats">
            {{ progress.copiedFiles }} / {{ progress.totalFiles }} {{ t('migration.mergeFiles') }}
          </div>
          <div v-if="currentPath" ref="currentPathRef" class="library-merge-dialog__path">
            {{ currentPath }}
          </div>
          <bubbleBox
            v-if="currentPath"
            :dom="currentPathRef || undefined"
            :title="currentPath"
            :max-width="620"
          />
          <div class="library-merge-dialog__lock-hint">{{ t('migration.mergeLockedHint') }}</div>
        </template>

        <template v-else-if="step === 'completed'">
          <div class="library-merge-dialog__result-title">
            {{ t('migration.mergeDialog.completedTitle') }}
          </div>
          <p class="library-merge-dialog__result-copy">
            {{
              t('migration.mergeDialog.completed', {
                songListCount: resultSummary?.songListCount || 0,
                copiedFileCount: resultSummary?.copiedFileCount || 0
              })
            }}
          </p>
          <div
            v-if="resultSummary?.sourceDeleteError"
            class="library-merge-dialog__status library-merge-dialog__status--warning"
          >
            <div>{{ t('migration.mergeDialog.sourceDeleteWarning') }}</div>
            <div class="library-merge-dialog__error-detail">
              {{ resultSummary.sourceDeleteError }}
            </div>
          </div>
        </template>

        <template v-else-if="step === 'failed'">
          <div class="library-merge-dialog__result-title">
            {{ t('migration.mergeDialog.failedTitle') }}
          </div>
          <div class="library-merge-dialog__status library-merge-dialog__status--error">
            <div class="library-merge-dialog__error-detail">{{ failureMessage }}</div>
          </div>
        </template>
      </div>
      <footer class="dialog-footer library-merge-dialog__footer">
        <template v-if="step === 'intro'">
          <button class="button library-merge-dialog__button" type="button" @click="openSetup">
            {{ t('migration.mergeDialog.startSetup') }} (Enter)
          </button>
          <button class="button library-merge-dialog__button" type="button" @click="close">
            {{ t('common.cancel') }} (Esc)
          </button>
        </template>
        <template v-else-if="step === 'setup' || step === 'checking'">
          <button
            class="button library-merge-dialog__button"
            :class="{ 'library-merge-dialog__button--disabled': isWorking }"
            type="button"
            :disabled="isWorking"
            @click="step = 'intro'"
          >
            {{ t('migration.mergeDialog.back') }}
          </button>
          <button
            class="button library-merge-dialog__button library-merge-dialog__button--primary"
            :class="{ 'library-merge-dialog__button--disabled': !canStart }"
            type="button"
            :disabled="!canStart"
            @click="startMerge"
          >
            {{ t('migration.mergeDialog.startMerge') }} (Enter)
          </button>
          <button
            class="button library-merge-dialog__button"
            :class="{ 'library-merge-dialog__button--disabled': isWorking }"
            type="button"
            :disabled="isWorking"
            @click="close"
          >
            {{ t('common.cancel') }} (Esc)
          </button>
        </template>
        <template v-else-if="step === 'running'">
          <div class="library-merge-dialog__running-hint">{{ t('migration.mergeLockedHint') }}</div>
        </template>
        <template v-else-if="step === 'completed'">
          <button
            class="button library-merge-dialog__button library-merge-dialog__button--primary"
            type="button"
            @click="close"
          >
            {{ t('common.close') }} (Esc)
          </button>
        </template>
        <template v-else-if="step === 'failed'">
          <button class="button library-merge-dialog__button" type="button" @click="returnToSetup">
            {{ t('migration.mergeDialog.returnToSetup') }}
          </button>
          <button class="button library-merge-dialog__button" type="button" @click="close">
            {{ t('common.close') }} (Esc)
          </button>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped lang="scss">
.library-merge-dialog .inner {
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

.library-merge-dialog__body {
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
}

.library-merge-dialog__lead {
  margin: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}

.library-merge-dialog__section {
  margin-top: 18px;
}

.library-merge-dialog__section h3 {
  margin: 0;
  color: var(--text);
  font-size: 14px;
  line-height: 1.4;
}

.library-merge-dialog__section p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.library-merge-dialog__source-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.library-merge-dialog__source-selected {
  color: var(--text-secondary);
  font-size: 13px;
}

.library-merge-dialog__button {
  border: 0;
  color: var(--text);
  cursor: pointer;
}

.library-merge-dialog__button--primary {
  background: var(--accent);
  color: #fff;
}

.library-merge-dialog__button--disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.library-merge-dialog__button--disabled:hover {
  background: var(--hover);
  color: var(--text);
}

.library-merge-dialog__path {
  overflow: hidden;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-merge-dialog__status {
  margin-top: 10px;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.55;
}

.library-merge-dialog__status--checking {
  color: var(--text-secondary);
}

.library-merge-dialog__status--success {
  color: var(--success, #107c10);
}

.library-merge-dialog__status--warning {
  color: var(--warning, #b67500);
}

.library-merge-dialog__status--error {
  color: var(--error, #f56c6c);
}

.library-merge-dialog__source-issue {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--error, #f56c6c) 48%, var(--border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--error, #f56c6c) 9%, var(--bg));
}

.library-merge-dialog__source-issue-icon {
  display: grid;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: var(--error, #f56c6c);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.library-merge-dialog__source-issue strong {
  display: block;
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
}

.library-merge-dialog__source-issue p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.library-merge-dialog__error-detail {
  margin-top: 4px;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
}

.library-merge-dialog__mode-option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
}

.library-merge-dialog__mode-option:has(input:checked) {
  border-color: var(--accent);
}

.library-merge-dialog__mode-option input {
  margin: 2px 0 0;
  accent-color: var(--accent);
}

.library-merge-dialog__mode-option strong,
.library-merge-dialog__mode-option small {
  display: block;
}

.library-merge-dialog__mode-option strong {
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
}

.library-merge-dialog__mode-option small {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.library-merge-dialog__progress-title,
.library-merge-dialog__result-title {
  color: var(--text);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.45;
}

.library-merge-dialog__progress-description,
.library-merge-dialog__file-stats,
.library-merge-dialog__lock-hint,
.library-merge-dialog__result-copy {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
}

.library-merge-dialog__progress-description {
  margin-top: 6px;
}

.library-merge-dialog__progress-track {
  position: relative;
  width: 100%;
  height: 9px;
  margin-top: 16px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border) 70%, transparent);
}

.library-merge-dialog__progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 68%, var(--bg-elev))
  );
  transition: width 0.2s ease;
}

.library-merge-dialog__progress-track--indeterminate::before {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 36%;
  border-radius: inherit;
  background: var(--accent);
  content: '';
  animation: library-merge-indeterminate 1.25s ease-in-out infinite;
}

.library-merge-dialog__progress-stats {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.library-merge-dialog__file-stats {
  margin-top: 6px;
}

.library-merge-dialog__lock-hint {
  margin-top: 14px;
}

.library-merge-dialog__result-copy {
  margin: 10px 0 0;
}

.library-merge-dialog__footer {
  align-items: center;
}

.library-merge-dialog__running-hint {
  flex: 1;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.5;
  text-align: right;
}

@keyframes library-merge-indeterminate {
  0% {
    transform: translateX(-130%);
  }
  100% {
    transform: translateX(340%);
  }
}
</style>
