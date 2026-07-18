<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import confirmDialog from '@renderer/components/confirmDialog'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'

type LibraryMergeMode = 'copy' | 'delete-source'
type LibraryMergeScope = 'full' | 'curated'
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
  | 'empty-curated-library'
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
type LibraryMergeBusyReason =
  | 'key-analysis'
  | 'metadata-auto-fill'
  | 'mixtape-waveform'
  | 'mixtape-raw-waveform'
  | 'background-task'
  | 'import'
  | 'audio-conversion'
  | 'playlist-batch-rename'
  | 'mixtape-stem'
  | 'mixtape-window'
  | 'library-tree-watcher'
  | 'recording'
  | 'unknown'
type LibraryMergeBusyDetails = {
  blocking: LibraryMergeBusyReason[]
  cancellable: LibraryMergeBusyReason[]
}

const props = withDefaults(
  defineProps<{
    scope?: LibraryMergeScope
  }>(),
  {
    scope: 'full'
  }
)

const emit = defineEmits<{
  close: []
}>()

const uuid = uuidV4()
const isCuratedScope = computed(() => props.scope === 'curated')
const dialogTextPrefix = computed(() =>
  isCuratedScope.value ? 'migration.mergeCuratedDialog' : 'migration.mergeDialog'
)
const phaseTextPrefix = computed(() =>
  isCuratedScope.value ? 'migration.mergeCuratedPhase' : 'migration.mergePhase'
)
const phaseDescriptionPrefix = computed(() =>
  isCuratedScope.value ? 'migration.mergeCuratedDescription' : 'migration.mergeDescription'
)
const lockedHintKey = computed(() =>
  isCuratedScope.value ? 'migration.mergeCuratedLockedHint' : 'migration.mergeLockedHint'
)
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

const KNOWN_BUSY_REASONS = new Set<LibraryMergeBusyReason>([
  'key-analysis',
  'metadata-auto-fill',
  'mixtape-waveform',
  'mixtape-raw-waveform',
  'background-task',
  'import',
  'audio-conversion',
  'playlist-batch-rename',
  'mixtape-stem',
  'mixtape-window',
  'library-tree-watcher',
  'recording'
])

const normalizeBusyReason = (value: unknown): LibraryMergeBusyReason => {
  const reason = getString(value) as LibraryMergeBusyReason
  return KNOWN_BUSY_REASONS.has(reason) ? reason : 'unknown'
}

const getBusyDetails = (value: unknown): LibraryMergeBusyDetails => {
  const details = isRecord(value) && isRecord(value.details) ? value.details : null
  const blockingRaw = details && Array.isArray(details.blocking) ? details.blocking : []
  const cancellableRaw = details && Array.isArray(details.cancellable) ? details.cancellable : []
  return {
    blocking: blockingRaw.map(normalizeBusyReason),
    cancellable: cancellableRaw.map(normalizeBusyReason)
  }
}

const formatBusyReasonLines = (reasons: LibraryMergeBusyReason[]): string[] => {
  const unique = Array.from(new Set(reasons.filter(Boolean)))
  if (unique.length === 0) return [`• ${t(`${dialogTextPrefix.value}.busyReasons.unknown`)}`]
  return unique.map((reason) => {
    const key = `${dialogTextPrefix.value}.busyReasons.${reason}`
    const label = t(key)
    return `• ${label === key ? t(`${dialogTextPrefix.value}.busyReasons.unknown`) : label}`
  })
}

const showBusyBlockingDialog = async (reasons: LibraryMergeBusyReason[]) => {
  await confirmDialog({
    title: t(`${dialogTextPrefix.value}.busyBlockingTitle`),
    content: [t(`${dialogTextPrefix.value}.busyBlockingLead`), ...formatBusyReasonLines(reasons)],
    confirmShow: false,
    textAlign: 'left',
    cancelText: t('common.close')
  })
}

const confirmCancelCancellableTasks = async (
  reasons: LibraryMergeBusyReason[]
): Promise<boolean> => {
  const result = await confirmDialog({
    title: t(`${dialogTextPrefix.value}.busyCancellableTitle`),
    content: [
      t(`${dialogTextPrefix.value}.busyCancellableLead`),
      ...formatBusyReasonLines(reasons)
    ],
    confirmShow: true,
    textAlign: 'left',
    confirmText: t(`${dialogTextPrefix.value}.busyCancellableConfirm`),
    cancelText: t(`${dialogTextPrefix.value}.busyCancellableCancel`)
  })
  return result === 'confirm'
}

const getSourceCheckIssueKind = (value: unknown): SourceCheckIssueKind => {
  const code = getErrorCode(value)
  if (code === 'SOURCE_MANIFEST_INVALID') return 'invalid-selection'
  if (code === 'SOURCE_EQUALS_TARGET') return 'same-library'
  if (code === 'NESTED_LIBRARY_ROOT') return 'nested-library'
  if (code === 'SOURCE_VERSION_INCOMPATIBLE' || code === 'SOURCE_SCHEMA_UNSUPPORTED') {
    return 'version-incompatible'
  }
  if (code === 'SOURCE_METADATA_UNSUPPORTED') return 'unregistered-data'
  if (code === 'SOURCE_CURATED_EMPTY') return 'empty-curated-library'
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
// Allow closing during source inspection so a multi-second integrity check cannot trap the UI.
// The actual merge run remains non-cancellable.
const canClose = computed(() => step.value !== 'running' && !isSelectingSource.value)
const inspectGeneration = ref(0)
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
const phaseTitleKey = computed(() => `${phaseTextPrefix.value}.${progress.value.phase}`)
const phaseDescriptionKey = computed(
  () => `${phaseDescriptionPrefix.value}.${progress.value.phase}`
)
const sourceCheckIssueTitleKey = computed(
  () =>
    `${dialogTextPrefix.value}.sourceIssues.${sourceCheckIssue.value?.kind || 'unavailable'}.title`
)
const sourceCheckIssueDescriptionKey = computed(
  () =>
    `${dialogTextPrefix.value}.sourceIssues.${sourceCheckIssue.value?.kind || 'unavailable'}.description`
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

const cancelActiveInspect = () => {
  inspectGeneration.value += 1
  void window.electron.ipcRenderer.invoke('library-merge:cancel-inspect').catch(() => {})
}

const close = () => {
  if (!canClose.value) return
  if (step.value === 'checking') cancelActiveInspect()
  closeWithAnimation(() => emit('close'))
}

const openSetup = () => {
  if (isWorking.value) return
  step.value = 'setup'
  failureMessage.value = ''
}

const selectSource = async () => {
  if (isWorking.value) return
  sourceCheckIssue.value = null
  isSelectingSource.value = true
  let selectedRoot = ''
  try {
    const response: unknown = await window.electron.ipcRenderer.invoke(
      'library-merge:select-source'
    )
    if (!isSuccessResponse(response)) {
      sourceRoot.value = ''
      setSourceCheckIssue(response)
      return
    }
    selectedRoot = getString(response.sourceRoot)
    if (!selectedRoot) return
    sourceRoot.value = selectedRoot
    sourceChecked.value = false
  } catch (error) {
    setSourceCheckIssue(error)
    return
  } finally {
    // Native file dialog is done; keep cancel available during the long inspect phase.
    isSelectingSource.value = false
  }

  step.value = 'checking'
  const generation = (inspectGeneration.value += 1)
  try {
    const inspected: unknown = await window.electron.ipcRenderer.invoke('library-merge:inspect', {
      sourceRoot: selectedRoot,
      scope: props.scope
    })
    if (generation !== inspectGeneration.value) return
    if (!isSuccessResponse(inspected)) {
      if (getErrorCode(inspected) === 'INSPECT_CANCELLED') {
        step.value = 'setup'
        return
      }
      setSourceCheckIssue(inspected)
      step.value = 'setup'
      return
    }
    sourceChecked.value = true
    step.value = 'setup'
  } catch (error) {
    if (generation !== inspectGeneration.value) return
    setSourceCheckIssue(error)
    step.value = 'setup'
  }
}

const invokeStartMerge = async (cancelCancellableTasks: boolean): Promise<unknown> =>
  window.electron.ipcRenderer.invoke('library-merge:start', {
    sourceRoot: sourceRoot.value,
    mode: mode.value,
    scope: props.scope,
    cancelCancellableTasks
  })

const handleBusyStartFailure = async (response: unknown): Promise<'handled' | 'retry-cancel'> => {
  const code = getErrorCode(response)
  if (code === 'LIBRARY_BUSY_BLOCKING') {
    const busy = getBusyDetails(response)
    await showBusyBlockingDialog(busy.blocking.length > 0 ? busy.blocking : busy.cancellable)
    return 'handled'
  }
  if (code === 'LIBRARY_BUSY_CANCELLABLE') {
    const busy = getBusyDetails(response)
    const confirmed = await confirmCancelCancellableTasks(busy.cancellable)
    return confirmed ? 'retry-cancel' : 'handled'
  }
  if (code === 'LIBRARY_BUSY_CANCEL_FAILED') {
    failureMessage.value =
      getErrorMessage(response) || t(`${dialogTextPrefix.value}.busyCancelFailed`)
    step.value = 'failed'
    return 'handled'
  }
  return 'handled'
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

  let cancelCancellableTasks = false
  try {
    // Scope-aware probe: curated skips mixtape-window/stem hard-blocks; pending-only
    // analysis is not reported here and is cleared silently when the lock is taken.
    const busyStatus: unknown = await window.electron.ipcRenderer.invoke(
      'library-merge:busy-status',
      { scope: props.scope }
    )
    if (isSuccessResponse(busyStatus)) {
      const blocking = Array.isArray(busyStatus.blocking)
        ? busyStatus.blocking.map(normalizeBusyReason)
        : []
      const cancellable = Array.isArray(busyStatus.cancellable)
        ? busyStatus.cancellable.map(normalizeBusyReason)
        : []
      if (blocking.length > 0) {
        await showBusyBlockingDialog(blocking)
        return
      }
      if (cancellable.length > 0) {
        const confirmed = await confirmCancelCancellableTasks(cancellable)
        if (!confirmed) return
        cancelCancellableTasks = true
      }
    }
  } catch {
    // If the probe fails, fall through and let the start lock report the real busy state.
  }

  step.value = 'running'
  try {
    let response: unknown = await invokeStartMerge(cancelCancellableTasks)
    let code = getErrorCode(response)
    if (
      code === 'LIBRARY_BUSY_BLOCKING' ||
      code === 'LIBRARY_BUSY_CANCELLABLE' ||
      code === 'LIBRARY_BUSY_CANCEL_FAILED'
    ) {
      step.value = 'setup'
      const action = await handleBusyStartFailure(response)
      if (action !== 'retry-cancel') return
      step.value = 'running'
      response = await invokeStartMerge(true)
      code = getErrorCode(response)
      if (
        code === 'LIBRARY_BUSY_BLOCKING' ||
        code === 'LIBRARY_BUSY_CANCELLABLE' ||
        code === 'LIBRARY_BUSY_CANCEL_FAILED'
      ) {
        step.value = 'setup'
        await handleBusyStartFailure(response)
        return
      }
    }

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
  const progressScope = getString(payload.scope)
  if (progressScope && progressScope !== props.scope) return
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
  cancelActiveInspect()
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
        {{ t(`${dialogTextPrefix}.title`) }}
      </div>
      <div class="library-merge-dialog__body">
        <template v-if="step === 'intro'">
          <p class="library-merge-dialog__lead">{{ t(`${dialogTextPrefix}.intro`) }}</p>
          <section class="library-merge-dialog__section">
            <h3>{{ t(`${dialogTextPrefix}.contentsTitle`) }}</h3>
            <p>{{ t(`${dialogTextPrefix}.contents`) }}</p>
          </section>
          <section class="library-merge-dialog__section">
            <h3>{{ t(`${dialogTextPrefix}.safetyTitle`) }}</h3>
            <p>{{ t(`${dialogTextPrefix}.safety`) }}</p>
          </section>
          <section class="library-merge-dialog__section">
            <h3>{{ t(`${dialogTextPrefix}.playlistTitle`) }}</h3>
            <p>{{ t(`${dialogTextPrefix}.playlist`) }}</p>
          </section>
        </template>

        <template v-else-if="step === 'setup' || step === 'checking'">
          <section class="library-merge-dialog__section">
            <h3>{{ t(`${dialogTextPrefix}.sourceTitle`) }}</h3>
            <p>{{ t(`${dialogTextPrefix}.sourceInstruction`) }}</p>
            <div class="library-merge-dialog__source-actions">
              <button
                class="button library-merge-dialog__button"
                :class="{ 'library-merge-dialog__button--disabled': isWorking }"
                type="button"
                :disabled="isWorking"
                @click="selectSource"
              >
                {{ t(`${dialogTextPrefix}.selectSource`) }}
              </button>
              <span v-if="sourceRoot" class="library-merge-dialog__source-selected">
                {{ t(`${dialogTextPrefix}.sourceSelected`) }}
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
              {{ t(`${dialogTextPrefix}.checkingSource`) }}
            </div>
            <div
              v-else-if="sourceRoot && !sourceCheckIssue"
              class="library-merge-dialog__status library-merge-dialog__status--success"
            >
              {{ t(`${dialogTextPrefix}.sourceCheckPassed`) }}
            </div>
            <div v-else-if="sourceCheckIssue" class="library-merge-dialog__source-issue">
              <div class="library-merge-dialog__source-issue-icon" aria-hidden="true">!</div>
              <div>
                <strong>{{ t(sourceCheckIssueTitleKey) }}</strong>
                <p>{{ t(sourceCheckIssueDescriptionKey) }}</p>
              </div>
            </div>
            <div v-else class="library-merge-dialog__status">
              {{ t(`${dialogTextPrefix}.sourceRequired`) }}
            </div>
          </section>

          <section class="library-merge-dialog__section">
            <h3>{{ t(`${dialogTextPrefix}.modeTitle`) }}</h3>
            <label class="library-merge-dialog__mode-option">
              <input v-model="mode" type="radio" value="copy" :disabled="isWorking" />
              <span>
                <strong>{{ t(`${dialogTextPrefix}.copyMode`) }}</strong>
                <small>{{ t(`${dialogTextPrefix}.copyDescription`) }}</small>
              </span>
            </label>
            <label class="library-merge-dialog__mode-option">
              <input v-model="mode" type="radio" value="delete-source" :disabled="isWorking" />
              <span>
                <strong>{{ t(`${dialogTextPrefix}.deleteMode`) }}</strong>
                <small>{{ t(`${dialogTextPrefix}.deleteDescription`) }}</small>
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
          <div class="library-merge-dialog__lock-hint">{{ t(lockedHintKey) }}</div>
        </template>

        <template v-else-if="step === 'completed'">
          <div class="library-merge-dialog__result-title">
            {{ t(`${dialogTextPrefix}.completedTitle`) }}
          </div>
          <p class="library-merge-dialog__result-copy">
            {{
              t(`${dialogTextPrefix}.completed`, {
                songListCount: resultSummary?.songListCount || 0,
                copiedFileCount: resultSummary?.copiedFileCount || 0
              })
            }}
          </p>
          <div
            v-if="resultSummary?.sourceDeleteError"
            class="library-merge-dialog__status library-merge-dialog__status--warning"
          >
            <div>{{ t(`${dialogTextPrefix}.sourceDeleteWarning`) }}</div>
            <div class="library-merge-dialog__error-detail">
              {{ resultSummary.sourceDeleteError }}
            </div>
          </div>
        </template>

        <template v-else-if="step === 'failed'">
          <div class="library-merge-dialog__result-title">
            {{ t(`${dialogTextPrefix}.failedTitle`) }}
          </div>
          <div class="library-merge-dialog__status library-merge-dialog__status--error">
            <div class="library-merge-dialog__error-detail">{{ failureMessage }}</div>
          </div>
        </template>
      </div>
      <footer class="dialog-footer library-merge-dialog__footer">
        <template v-if="step === 'intro'">
          <button class="button library-merge-dialog__button" type="button" @click="openSetup">
            {{ t(`${dialogTextPrefix}.startSetup`) }} (Enter)
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
            {{ t(`${dialogTextPrefix}.back`) }}
          </button>
          <button
            class="button library-merge-dialog__button library-merge-dialog__button--primary"
            :class="{ 'library-merge-dialog__button--disabled': !canStart }"
            type="button"
            :disabled="!canStart"
            @click="startMerge"
          >
            {{ t(`${dialogTextPrefix}.startMerge`) }} (Enter)
          </button>
          <button
            class="button library-merge-dialog__button"
            :class="{ 'library-merge-dialog__button--disabled': !canClose }"
            type="button"
            :disabled="!canClose"
            @click="close"
          >
            {{ t('common.cancel') }} (Esc)
          </button>
        </template>
        <template v-else-if="step === 'running'">
          <div class="library-merge-dialog__running-hint">{{ t(lockedHintKey) }}</div>
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
            {{ t(`${dialogTextPrefix}.returnToSetup`) }}
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
