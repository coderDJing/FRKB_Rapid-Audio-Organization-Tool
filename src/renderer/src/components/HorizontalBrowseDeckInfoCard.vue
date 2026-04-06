<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { getKeyDisplayText } from '@shared/keyDisplay'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  song: ISongInfo | null
  beatSyncEnabled: boolean
  beatSyncBlinking: boolean
  masterActive: boolean
  currentSeconds?: number
  durationSeconds?: number
}>()

const emit = defineEmits<{
  (event: 'trigger-beat-sync'): void
  (event: 'toggle-master'): void
  (event: 'eject-song'): void
}>()

const runtime = useRuntimeStore()
const coverUrl = ref('')

const revokeCoverUrl = () => {
  if (coverUrl.value && coverUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(coverUrl.value)
  }
  coverUrl.value = ''
}

const toUint8Array = (raw: unknown): Uint8Array | null => {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  if (typeof raw === 'object' && Array.isArray((raw as any).data)) {
    return new Uint8Array((raw as any).data)
  }
  return null
}

const applyCoverBytes = (bytes: Uint8Array, format?: string) => {
  revokeCoverUrl()
  const blob = new Blob([bytes.slice()], { type: format || 'image/jpeg' })
  coverUrl.value = URL.createObjectURL(blob)
}

const loadCover = async () => {
  revokeCoverUrl()

  const song = props.song
  if (!song) return

  const embeddedBytes = toUint8Array(song.cover?.data)
  if (embeddedBytes && embeddedBytes.length > 0) {
    applyCoverBytes(embeddedBytes, song.cover?.format)
    return
  }

  const filePath = String(song.filePath || '').trim()
  if (!filePath) return

  try {
    const thumb = (await window.electron.ipcRenderer.invoke(
      'getSongCoverThumb',
      filePath,
      96,
      ''
    )) as {
      format?: string
      data?: Uint8Array | { data: number[] }
      dataUrl?: string
    } | null

    if (filePath !== String(props.song?.filePath || '').trim()) return
    if (thumb?.dataUrl) {
      coverUrl.value = thumb.dataUrl
      return
    }
    const bytes = toUint8Array(thumb?.data)
    if (bytes && bytes.length > 0) {
      applyCoverBytes(bytes, thumb?.format)
    }
  } catch {}
}

const parseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  return parts[0]
}

const formatSeconds = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

const titleText = computed(
  () => String(props.song?.title || props.song?.fileName || '').trim() || '--'
)
const artistText = computed(() => String(props.song?.artist || '').trim() || '--')
const keyDisplayText = computed(() => {
  const raw = String(props.song?.key || '').trim()
  if (!raw) return '--'
  if (raw.toLowerCase() === 'o') return '-'
  const style = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
  const display = getKeyDisplayText(raw, style)
  return display || '--'
})
const bpmText = computed(() => {
  const bpm = Number(props.song?.bpm)
  return Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(2) : '--'
})
const totalSeconds = computed(() => {
  const explicit = Number(props.durationSeconds)
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit
  }
  return parseDurationToSeconds(props.song?.duration)
})
const elapsedSeconds = computed(() => {
  const current = Number(props.currentSeconds)
  if (!Number.isFinite(current) || current < 0) return 0
  return Math.min(current, totalSeconds.value || current)
})
const remainingSeconds = computed(() => Math.max(0, totalSeconds.value - elapsedSeconds.value))
const elapsedText = computed(() => formatSeconds(elapsedSeconds.value))
const remainingText = computed(() => `-${formatSeconds(remainingSeconds.value)}`)

watch(
  () => props.song?.filePath ?? '',
  () => void loadCover(),
  { immediate: true }
)

onUnmounted(() => {
  revokeCoverUrl()
})
</script>

<template>
  <div class="deck-info-card">
    <div class="deck-info-card__cover-anchor">
      <div class="deck-info-card__cover">
        <img v-if="coverUrl" :src="coverUrl" alt="" draggable="false" />
        <div v-else class="deck-info-card__cover-placeholder"></div>
      </div>
      <button
        v-if="props.song"
        type="button"
        class="deck-info-card__eject-btn"
        :title="t('common.eject')"
        :aria-label="t('common.eject')"
        @pointerdown.stop
        @click.stop="emit('eject-song')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M8 2.5 13 9H3z" fill="currentColor" />
          <rect x="3" y="10.75" width="10" height="2.25" rx="0.8" fill="currentColor" />
        </svg>
      </button>
    </div>

    <div class="deck-info-card__content">
      <div class="deck-info-card__identity">
        <span class="deck-info-card__title-line">{{ titleText }}</span>
        <span v-if="artistText !== '--'" class="deck-info-card__divider">/</span>
        <span v-if="artistText !== '--'" class="deck-info-card__artist-line">{{ artistText }}</span>
      </div>

      <div class="deck-info-card__stats">
        <div class="deck-info-card__meta-line">{{ elapsedText }}</div>
        <span class="deck-info-card__meta-gap"></span>
        <div class="deck-info-card__meta-line">{{ remainingText }}</div>
        <span class="deck-info-card__meta-separator"></span>
        <div class="deck-info-card__meta-line">{{ keyDisplayText }}</div>
        <span class="deck-info-card__meta-separator"></span>
        <div class="deck-info-card__meta-line">{{ bpmText }}</div>
      </div>
    </div>

    <div class="deck-info-card__actions">
      <button
        type="button"
        class="deck-info-action"
        :class="{ 'is-active': props.beatSyncEnabled, 'is-blinking': props.beatSyncBlinking }"
        :disabled="!props.song"
        @click.stop="emit('trigger-beat-sync')"
      >
        BEAT SYNC
      </button>
      <button
        type="button"
        class="deck-info-action deck-info-action--master"
        :class="{ 'is-active': props.masterActive }"
        :disabled="!props.song"
        @click.stop="emit('toggle-master')"
      >
        MASTER
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.deck-info-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  width: 100%;
  height: 100%;
  padding: 4px 8px;
  box-sizing: border-box;
  min-width: 0;
  overflow: visible;
}

.deck-info-card__cover-anchor {
  position: relative;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  z-index: 10020;
}

.deck-info-card__cover {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg);
  flex-shrink: 0;
}

.deck-info-card__cover img,
.deck-info-card__cover-placeholder {
  display: block;
  width: 100%;
  height: 100%;
}

.deck-info-card__cover-placeholder {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
}

.deck-info-card__eject-btn {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: rgba(7, 11, 18, 0.56);
  color: #f5f7fa;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: none;
  pointer-events: none;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    opacity 0.14s ease,
    background-color 0.14s ease,
    box-shadow 0.14s ease;
}

.deck-info-card__cover-anchor:hover .deck-info-card__eject-btn,
.deck-info-card__cover-anchor:focus-within .deck-info-card__eject-btn {
  opacity: 1;
  pointer-events: auto;
}

.deck-info-card__eject-btn:hover,
.deck-info-card__eject-btn:focus-visible {
  background: rgba(7, 11, 18, 0.72);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, white);
  outline: none;
}

.deck-info-card__eject-btn svg {
  width: 15px;
  height: 15px;
  display: block;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.28));
}

.deck-info-card__title-line,
.deck-info-card__artist-line,
.deck-info-card__meta-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deck-info-card__content {
  display: grid;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  row-gap: 5px;
  min-width: 0;
  min-height: 0;
}

.deck-info-card__identity {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}

.deck-info-card__title-line {
  color: var(--text);
  font-size: 14px;
  line-height: 1.15;
  font-weight: 600;
  min-width: 0;
}

.deck-info-card__divider {
  flex: 0 0 auto;
  color: var(--text-weak);
  font-size: 11px;
  line-height: 1;
}

.deck-info-card__artist-line {
  flex: 0 1 auto;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.15;
  min-width: 0;
}

.deck-info-card__meta-line {
  flex: 0 0 auto;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.deck-info-card__stats {
  display: flex;
  align-items: center;
  min-width: 0;
  margin-left: 1px;
}

.deck-info-card__meta-gap {
  flex: 0 0 auto;
  width: 14px;
}

.deck-info-card__meta-separator {
  flex: 0 0 auto;
  width: 1px;
  height: 12px;
  background: var(--border);
  opacity: 0.72;
  margin: 0 9px;
}

.deck-info-card__actions {
  display: grid;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  align-items: center;
  justify-items: stretch;
  gap: 4px;
  height: 34px;
  flex: 0 0 auto;
  margin-left: 12px;
}

.deck-info-action {
  min-width: 66px;
  height: 100%;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-weak);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.01em;
  white-space: nowrap;
  box-sizing: border-box;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.deck-info-action:hover {
  border-color: rgba(255, 255, 255, 0.22);
}

.deck-info-action:disabled {
  opacity: 0.46;
  cursor: not-allowed;
}

.deck-info-action:disabled:hover {
  border-color: var(--border);
}

.deck-info-action.is-active {
  color: #ffffff;
  border-color: rgba(42, 144, 255, 0.95);
  background: linear-gradient(180deg, rgba(35, 137, 255, 0.96), rgba(0, 120, 212, 0.96));
  box-shadow:
    0 0 0 1px rgba(12, 84, 156, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.24);
}

.deck-info-action--master {
  color: var(--text-weak);
}

.deck-info-action--master:hover {
  border-color: color-mix(in srgb, var(--shell-cue-accent, #d98921) 38%, transparent);
  color: var(--text-weak);
}

.deck-info-action--master.is-active {
  color: var(--shell-cue-accent, #d98921);
  border-color: color-mix(in srgb, var(--shell-cue-accent, #d98921) 88%, white);
  background: transparent;
  box-shadow: none;
}

.deck-info-action.is-blinking {
  animation: deck-info-action-sync-blink 0.85s steps(2, end) infinite;
}

@keyframes deck-info-action-sync-blink {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.38;
  }
}
</style>
