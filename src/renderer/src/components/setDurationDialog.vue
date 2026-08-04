<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { normalizeSongHotCues, resolveSongHotCueLabel } from '@shared/hotCues'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import type { ISongInfo } from 'src/types/globals'

const STORAGE_KEY = 'frkb_set_duration_cue_slots_v1'
const CUE_SLOT_COUNT = 8
type CueBoundary = number | 'start' | 'end'

const props = defineProps<{ songs: ISongInfo[] }>()
const emits = defineEmits<{ close: [] }>()

const runtime = useRuntimeStore()
const scope = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const isCueSlot = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) < CUE_SLOT_COUNT

const readSavedSlots = (): [CueBoundary, CueBoundary] => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as unknown
    if (Array.isArray(saved) && saved.length === 2) {
      const start = saved[0] === 'start' || isCueSlot(saved[0]) ? saved[0] : 0
      const end = saved[1] === 'end' || isCueSlot(saved[1]) ? saved[1] : 1
      if (!(isCueSlot(start) && start === end)) {
        return [start, end]
      }
      return [start, 'end']
    }
  } catch {}
  return [0, 1]
}

const [savedStartSlot, savedEndSlot] = readSavedSlots()
const startSlot = ref<CueBoundary>(savedStartSlot)
const endSlot = ref<CueBoundary>(savedEndSlot)
const startCueOptions = computed(() => [
  { label: t('playlist.setDurationTrackStart'), value: 'start' },
  ...Array.from({ length: CUE_SLOT_COUNT }, (_, slot) => ({
    label: resolveSongHotCueLabel(slot),
    value: slot,
    disabled: endSlot.value === slot
  }))
])
const endCueOptions = computed(() => [
  ...Array.from({ length: CUE_SLOT_COUNT }, (_, slot) => ({
    label: resolveSongHotCueLabel(slot),
    value: slot,
    disabled: startSlot.value === slot
  })),
  { label: t('playlist.setDurationTrackEnd'), value: 'end' }
])

const parseDurationSec = (duration: unknown): number => {
  const text = String(duration || '').trim()
  if (!text) return 0
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  const parts = text.split(':').map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`
}

const orderedSongs = computed(() =>
  props.songs
    .map((song, index) => ({ song, index }))
    .sort((left, right) => {
      const leftOrder = Number(left.song.playlistTrackNumber)
      const rightOrder = Number(right.song.playlistTrackNumber)
      const leftValid = Number.isFinite(leftOrder)
      const rightValid = Number.isFinite(rightOrder)
      if (leftValid && rightValid && leftOrder !== rightOrder) return leftOrder - rightOrder
      if (leftValid !== rightValid) return leftValid ? -1 : 1
      return left.index - right.index
    })
)

const summary = computed(() => {
  let totalSec = 0
  let startFallbackCount = 0
  let endFallbackCount = 0
  let unknownDurationCount = 0
  for (const { song } of orderedSongs.value) {
    const durationSec = parseDurationSec(song.duration)
    if (durationSec <= 0) {
      unknownDurationCount += 1
      continue
    }
    const hotCues = normalizeSongHotCues(song.hotCues, durationSec)
    const startCue = isCueSlot(startSlot.value)
      ? hotCues.find((cue) => cue.slot === startSlot.value)
      : null
    const endCue = isCueSlot(endSlot.value)
      ? hotCues.find((cue) => cue.slot === endSlot.value)
      : null
    const startSec = startCue?.sec ?? 0
    const endSec = endCue?.sec ?? durationSec
    if (startSlot.value !== 'start' && !startCue) startFallbackCount += 1
    if (endSlot.value !== 'end' && !endCue) endFallbackCount += 1
    totalSec += Math.max(0, endSec - startSec)
  }
  return { totalSec, startFallbackCount, endFallbackCount, unknownDurationCount }
})

watch([startSlot, endSlot], ([start, end]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([start, end]))
  } catch {}
})

const close = () => closeWithAnimation(() => emits('close'))

onMounted(() => {
  runtime.confirmShow = true
  hotkeys('Esc', scope, close)
  utils.setHotkeysScpoe(scope)
})

onUnmounted(() => {
  runtime.confirmShow = false
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner set-duration-dialog">
      <div class="dialog-title dialog-header">
        <span>{{ t('playlist.setDurationTitle') }}</span>
      </div>
      <div class="set-duration-dialog__content">
        <div class="set-duration-dialog__total">{{ formatDuration(summary.totalSec) }}</div>
        <div class="set-duration-dialog__total-label">{{ t('playlist.setDurationTotal') }}</div>
        <div class="set-duration-dialog__settings">
          <label>
            <span>{{ t('playlist.setDurationStartCue') }}</span>
            <BaseSelect
              v-model="startSlot"
              :options="startCueOptions"
              :width="100"
              :show-bubble="false"
            />
          </label>
          <label>
            <span>{{ t('playlist.setDurationEndCue') }}</span>
            <BaseSelect
              v-model="endSlot"
              :options="endCueOptions"
              :width="100"
              :show-bubble="false"
            />
          </label>
        </div>
        <div class="set-duration-dialog__hint">
          {{ t('playlist.setDurationHint') }}
        </div>
        <div class="set-duration-dialog__notice">
          {{ t('playlist.setDurationTempoNotice') }}
        </div>
        <div class="set-duration-dialog__details">
          <span>{{ t('playlist.setDurationTrackCount', { count: orderedSongs.length }) }}</span>
          <span v-if="startSlot !== 'start'">
            {{ t('playlist.setDurationStartFallback', { count: summary.startFallbackCount }) }}
          </span>
          <span v-if="endSlot !== 'end'">
            {{ t('playlist.setDurationEndFallback', { count: summary.endFallbackCount }) }}
          </span>
          <span v-if="summary.unknownDurationCount">
            {{ t('playlist.setDurationUnknownDuration', { count: summary.unknownDurationCount }) }}
          </span>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button set-duration-dialog__close" @click="close">
          {{ t('common.close') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.set-duration-dialog {
  width: 700px;
  min-height: 310px;
  display: flex;
  flex-direction: column;
}

.set-duration-dialog__content {
  flex: 1;
  padding: 24px 30px 20px;
  color: var(--text);
  text-align: center;
}

.set-duration-dialog__total {
  font-size: 42px;
  font-weight: 600;
  color: var(--theme);
  font-variant-numeric: tabular-nums;
}

.set-duration-dialog__total-label,
.set-duration-dialog__hint,
.set-duration-dialog__details {
  color: var(--text-secondary, var(--text));
}

.set-duration-dialog__total-label {
  margin-top: 4px;
}

.set-duration-dialog__settings {
  display: flex;
  justify-content: center;
  gap: 28px;
  margin: 26px 0 18px;
}

.set-duration-dialog__settings label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.set-duration-dialog__hint {
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
}

.set-duration-dialog__notice {
  margin-top: 12px;
  padding: 9px 12px;
  border: 1px solid var(--border, var(--text-secondary));
  border-radius: 4px;
  color: var(--text-secondary, var(--text));
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  white-space: nowrap;
}

.set-duration-dialog__details {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 7px 16px;
  margin-top: 20px;
  font-size: 12px;
  white-space: nowrap;
}

.set-duration-dialog__close {
  width: 100px;
  box-sizing: border-box;
  text-align: center;
}
</style>
