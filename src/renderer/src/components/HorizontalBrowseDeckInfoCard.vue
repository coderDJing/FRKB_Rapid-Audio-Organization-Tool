<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { getKeyDisplayText } from '@shared/keyDisplay'
import musicIconAsset from '@renderer/assets/musicIcon.svg?asset'

const props = defineProps<{
  song: ISongInfo | null
  beatSyncActive: boolean
  masterActive: boolean
  currentSeconds?: number
  durationSeconds?: number
}>()

const emit = defineEmits<{
  (event: 'toggle-beat-sync'): void
  (event: 'toggle-master'): void
}>()

const runtime = useRuntimeStore()
const musicIcon = musicIconAsset
const coverUrl = ref('')
const hoverCardVisible = ref(false)

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
const albumText = computed(() => String(props.song?.album || '').trim() || '--')
const labelText = computed(() => String(props.song?.label || '').trim() || '--')
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
  () => {
    hoverCardVisible.value = false
    void loadCover()
  },
  { immediate: true }
)

onUnmounted(() => {
  revokeCoverUrl()
})
</script>

<template>
  <div class="deck-info-card">
    <div
      class="deck-info-card__cover-anchor"
      @mouseenter="props.song && (hoverCardVisible = true)"
      @mouseleave="hoverCardVisible = false"
    >
      <div class="deck-info-card__cover">
        <img v-if="coverUrl" :src="coverUrl" alt="" draggable="false" />
        <div v-else class="deck-info-card__cover-placeholder"></div>
      </div>

      <transition name="fade">
        <div v-if="props.song && hoverCardVisible" class="deck-info-card__hover-card">
          <div class="deck-info-card__hover-cover">
            <img
              v-if="coverUrl"
              :src="coverUrl"
              class="deck-info-card__hover-cover-image"
              draggable="false"
            />
            <img
              v-else
              :src="musicIcon"
              class="deck-info-card__hover-cover-fallback"
              draggable="false"
            />
          </div>
          <div class="deck-info-card__hover-info deck-info-card__hover-info--title">
            {{ titleText }}
          </div>
          <div class="deck-info-card__hover-info deck-info-card__hover-info--artist">
            {{ artistText }}
          </div>
          <div class="deck-info-card__hover-info deck-info-card__hover-info--meta">
            {{ albumText }}
          </div>
          <div class="deck-info-card__hover-info deck-info-card__hover-info--meta">
            {{ labelText }}
          </div>
        </div>
      </transition>
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
        :class="{ 'is-active': props.beatSyncActive }"
        @click.stop="emit('toggle-beat-sync')"
      >
        BEAT SYNC
      </button>
      <button
        type="button"
        class="deck-info-action"
        :class="{ 'is-active': props.masterActive }"
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

.deck-info-card__hover-card {
  position: absolute;
  left: 0;
  top: 25px;
  width: 300px;
  height: 370px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding-top: 10px;
  box-sizing: border-box;
  color: var(--text);
  z-index: 10050;
  user-select: text;
  -webkit-user-select: text;
}

.deck-info-card__hover-cover {
  width: 100%;
  height: 280px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.deck-info-card__hover-cover-image {
  width: 280px;
  height: 280px;
  display: block;
}

.deck-info-card__hover-cover-fallback {
  width: 48px;
  height: 48px;
  display: block;
}

.deck-info-card__hover-info {
  width: 100%;
  padding: 5px 10px 0;
  box-sizing: border-box;
  white-space: nowrap;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
}

.deck-info-card__hover-info--title {
  font-size: 14px;
}

.deck-info-card__hover-info--artist {
  font-size: 12px;
}

.deck-info-card__hover-info--meta {
  font-size: 10px;
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

.deck-info-action.is-active {
  color: #ffffff;
  border-color: rgba(42, 144, 255, 0.95);
  background: linear-gradient(180deg, rgba(35, 137, 255, 0.96), rgba(0, 120, 212, 0.96));
  box-shadow:
    0 0 0 1px rgba(12, 84, 156, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.24);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
