<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import recordIconAsset from '@renderer/assets/record.svg?asset'
import type { HorizontalBrowseTransportRecordingStatus } from '@shared/horizontalBrowseTransport'
import { RECORDING_LIBRARY_CHANGED_EVENT } from '@shared/recordingLibrary'

const runtime = useRuntimeStore()
const emptyStatus = (): HorizontalBrowseTransportRecordingStatus => ({
  state: 'idle',
  filePath: undefined,
  sampleRate: 0,
  channels: 2,
  recordedFrames: 0,
  recorded: false,
  error: undefined
})

const recordingStatus = ref<HorizontalBrowseTransportRecordingStatus>(emptyStatus())
const busy = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let durationRafId = 0
let lastPollFrames = 0
let lastPollTimestamp = 0

const isHorizontalMode = computed(() => runtime.mainWindowBrowseMode === 'horizontal')
const hasRecordingSession = computed(
  () =>
    recordingStatus.value.state === 'armed' ||
    recordingStatus.value.state === 'recording' ||
    recordingStatus.value.state === 'error'
)
const isRecordActive = computed(
  () => recordingStatus.value.state === 'armed' || recordingStatus.value.state === 'recording'
)
const recordButtonClasses = computed(() => ({
  'is-idle': recordingStatus.value.state === 'idle',
  'is-armed': recordingStatus.value.state === 'armed',
  'is-recording': recordingStatus.value.state === 'recording',
  'is-error': recordingStatus.value.state === 'error',
  'is-busy': busy.value
}))
const currentRecordingDuration = ref('')

const topToolbarRecordIconStyle = {
  '--top-toolbar-record-icon-mask': `url("${recordIconAsset}")`
}
const tooltipText = computed(() => {
  if (busy.value) return t('player.recordingBusy')
  if (recordingStatus.value.state === 'armed') return t('player.recordingArmed')
  if (recordingStatus.value.state === 'recording') return t('player.stopRecording')
  if (recordingStatus.value.state === 'error') return t('player.recordingError')
  return t('player.startRecording')
})

const normalizeStatus = (value: unknown): HorizontalBrowseTransportRecordingStatus => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const state = raw.state
  return {
    state:
      state === 'armed' || state === 'recording' || state === 'error' || state === 'idle'
        ? state
        : 'idle',
    filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined,
    sampleRate: Number(raw.sampleRate || 0),
    channels: Number(raw.channels || 2),
    recordedFrames: Number(raw.recordedFrames || 0),
    recorded: Boolean(raw.recorded),
    error: typeof raw.error === 'string' && raw.error.trim() ? raw.error : undefined
  }
}

const resolveRecordingFileName = (filePath: string | undefined) => {
  const fileName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop()
      ?.trim() || ''
  return fileName || t('player.recordingUnknownFile')
}

const padDurationPart = (value: number) => String(value).padStart(2, '0')

const formatRecordingDuration = (seconds: number, showMs = false) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return showMs ? '00:00.00' : '00:00'
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const restSeconds = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  if (hours > 0) {
    return showMs
      ? `${hours}:${padDurationPart(minutes)}:${padDurationPart(restSeconds)}.${padDurationPart(Math.floor(ms / 10))}`
      : `${hours}:${padDurationPart(minutes)}:${padDurationPart(restSeconds)}`
  }
  return showMs
    ? `${padDurationPart(minutes)}:${padDurationPart(restSeconds)}.${padDurationPart(Math.floor(ms / 10))}`
    : `${padDurationPart(minutes)}:${padDurationPart(restSeconds)}`
}

const buildRecordingSavedContent = (status: HorizontalBrowseTransportRecordingStatus) => {
  const sampleRate = Math.round(Number(status.sampleRate || 0))
  const sampleRateText =
    sampleRate > 0 ? `${sampleRate} Hz` : t('player.recordingUnknownSampleRate')
  const channels = Math.max(1, Math.round(Number(status.channels || 2)))
  const durationSeconds = sampleRate > 0 ? Number(status.recordedFrames || 0) / sampleRate : 0
  return [
    t('player.recordingSavedToLibrary'),
    t('player.recordingSavedFile', { name: resolveRecordingFileName(status.filePath) }),
    t('player.recordingSavedFormat', { channels, sampleRate: sampleRateText }),
    t('player.recordingSavedDuration', {
      duration: formatRecordingDuration(durationSeconds, true)
    }),
    t('player.recordingSavedQuality'),
    t('player.recordingSavedPath', { path: status.filePath || '' })
  ]
}

const showRecordingSavedDialog = (status: HorizontalBrowseTransportRecordingStatus) => {
  void confirm({
    title: t('player.recordingSavedTitle'),
    content: buildRecordingSavedContent(status),
    confirmShow: false,
    textAlign: 'left',
    innerHeight: 360,
    innerWidth: 540,
    canCopyText: true
  })
}

const refreshRecordingSnapshot = async () => {
  const status = await window.electron.ipcRenderer.invoke(
    'horizontal-browse-transport:recording-snapshot'
  )
  recordingStatus.value = normalizeStatus(status)
  if (status.state === 'recording') {
    lastPollFrames = Number(status.recordedFrames) || 0
    lastPollTimestamp = Date.now()
  }
}

const startPolling = () => {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!isHorizontalMode.value && !hasRecordingSession.value) return
    void refreshRecordingSnapshot().catch(() => {})
  }, 500)
}

const stopPolling = () => {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

const updateDuration = () => {
  durationRafId = requestAnimationFrame(updateDuration)
  if (recordingStatus.value.state !== 'recording') return
  const sampleRate = recordingStatus.value.sampleRate
  if (sampleRate > 0 && lastPollTimestamp > 0) {
    const elapsedSincePoll = (Date.now() - lastPollTimestamp) / 1000
    const estimatedFrames = lastPollFrames + elapsedSincePoll * sampleRate
    currentRecordingDuration.value = formatRecordingDuration(estimatedFrames / sampleRate, true)
  }
}

const startDurationTimer = () => {
  if (durationRafId) return
  durationRafId = requestAnimationFrame(updateDuration)
}

const stopDurationTimer = () => {
  if (!durationRafId) return
  cancelAnimationFrame(durationRafId)
  durationRafId = 0
}

const startRecording = async () => {
  const status = await window.electron.ipcRenderer.invoke(
    'horizontal-browse-transport:recording-start'
  )
  recordingStatus.value = normalizeStatus(status)
  lastPollFrames = Number(status.recordedFrames) || 0
  lastPollTimestamp = Date.now()
  startPolling()
  startDurationTimer()
}

const stopRecording = async () => {
  const status = await window.electron.ipcRenderer.invoke(
    'horizontal-browse-transport:recording-stop'
  )
  const nextStatus = normalizeStatus(status)
  recordingStatus.value = nextStatus
  lastPollFrames = 0
  lastPollTimestamp = 0
  stopDurationTimer()
  if (nextStatus.recorded) {
    emitter.emit(RECORDING_LIBRARY_CHANGED_EVENT, { hasRecordings: true })
    showRecordingSavedDialog(nextStatus)
  }
  if (nextStatus.error) {
    console.error('[horizontal-browse-recording] stop failed', nextStatus.error)
  }
  if (!isHorizontalMode.value) {
    stopPolling()
  }
}

const toggleRecording = async () => {
  if (busy.value) return
  busy.value = true
  try {
    if (hasRecordingSession.value) {
      await stopRecording()
    } else {
      await startRecording()
    }
  } catch (error) {
    recordingStatus.value = {
      ...recordingStatus.value,
      state: 'error',
      error: error instanceof Error ? error.message : String(error)
    }
    console.error('[horizontal-browse-recording] toggle failed', error)
  } finally {
    busy.value = false
  }
}

const handleRecordingLibraryChanged = (_event: unknown, payload?: unknown) => {
  const status = normalizeStatus(payload)
  if (status.state !== 'idle' || status.recorded || status.error) {
    recordingStatus.value = status
  }
}

watch(
  () => runtime.mainWindowBrowseMode,
  (mode) => {
    if (mode === 'horizontal') {
      void refreshRecordingSnapshot().catch(() => {})
      startPolling()
      startDurationTimer()
      return
    }
    if (hasRecordingSession.value) {
      void stopRecording().catch(() => {})
    } else {
      stopPolling()
      stopDurationTimer()
    }
  }
)

watch(
  () => recordingStatus.value.state,
  (state) => {
    if (state !== 'recording') {
      currentRecordingDuration.value = ''
    }
  }
)

onMounted(() => {
  window.electron.ipcRenderer.on(RECORDING_LIBRARY_CHANGED_EVENT, handleRecordingLibraryChanged)
  if (isHorizontalMode.value) {
    void refreshRecordingSnapshot().catch(() => {})
    startPolling()
    startDurationTimer()
  }
})

onBeforeUnmount(() => {
  stopPolling()
  stopDurationTimer()
  window.electron.ipcRenderer.removeListener(
    RECORDING_LIBRARY_CHANGED_EVENT,
    handleRecordingLibraryChanged
  )
})
</script>

<template>
  <div v-if="isHorizontalMode" class="topToolbarRecordingArea">
    <bubbleBoxTrigger
      tag="button"
      class="topToolbarRecordButton"
      :class="recordButtonClasses"
      :style="topToolbarRecordIconStyle"
      :title="tooltipText"
      :aria-label="tooltipText"
      :aria-pressed="isRecordActive ? 'true' : 'false'"
      :aria-disabled="busy ? 'true' : 'false'"
      type="button"
      @click="toggleRecording"
    >
      <span class="topToolbarRecordIcon"></span>
    </bubbleBoxTrigger>
    <span v-if="currentRecordingDuration" class="topToolbarRecordDuration">
      {{ currentRecordingDuration }}
    </span>
  </div>
</template>
