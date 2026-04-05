<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckInfoCard from '@renderer/components/HorizontalBrowseDeckInfoCard.vue'
import HorizontalBrowseRawWaveformDetail from '@renderer/components/HorizontalBrowseRawWaveformDetail.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
} from '@renderer/components/horizontalBrowseWaveform.constants'
import MixtapeBeatAlignGridAdjustToolbar from '@renderer/components/mixtapeBeatAlignGridAdjustToolbar.vue'
import { parsePreviewBpmInput } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { createHorizontalBrowseNativeTransport } from '@renderer/components/horizontalBrowseNativeTransport'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec
} from '@renderer/components/horizontalBrowseDetailMath'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'

type DeckKey = HorizontalBrowseDeckKey
type HorizontalBrowseLoadSongPayload = {
  deck?: DeckKey
  song?: ISongInfo | null
}
type SharedSongGridPayload = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
} | null
type DeckToolbarState = {
  disabled: boolean
  bpmInputValue: string
  bpmStep: number
  bpmMin: number
  bpmMax: number
  barLinePicking: boolean
}
type DeckTransportStateOverride = Partial<{
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
}>

type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

const createDefaultDeckToolbarState = (): DeckToolbarState => ({
  disabled: true,
  bpmInputValue: '128.00',
  bpmStep: 0.01,
  bpmMin: 1,
  bpmMax: 300,
  barLinePicking: false
})
const FADER_TRAVEL_INSET_RATIO = 0.17

const runtime = useRuntimeStore()
const topDeckSong = ref<ISongInfo | null>(null)
const bottomDeckSong = ref<ISongInfo | null>(null)
const topDeckCuePointSeconds = ref(0)
const bottomDeckCuePointSeconds = ref(0)
const topDetailRef = ref<any | null>(null)
const bottomDetailRef = ref<any | null>(null)
const faderRef = ref<HTMLElement | null>(null)
const faderRailRef = ref<HTMLElement | null>(null)
const topDeckToolbarState = ref<DeckToolbarState>(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref<DeckToolbarState>(createDefaultDeckToolbarState())
const hoveredDeckKey = ref<DeckKey | null>(null)
const faderDragging = ref(false)
const faderValue = ref(0)
const sharedDetailZoomState = ref<SharedDetailZoomState>({
  value: HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  anchorRatio: 0.5,
  sourceDirection: null,
  revision: 0
})
const topDeckRenderCurrentSeconds = ref(0)
const bottomDeckRenderCurrentSeconds = ref(0)
const regionDragDepth = reactive<Record<number, number>>({
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0,
  7: 0,
  8: 0
})

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const resolveFaderTravelPercentByValue = (value: number) => {
  const travelPercent = FADER_TRAVEL_INSET_RATIO * 100
  const usablePercent = 100 - travelPercent * 2
  return travelPercent + (clampNumber(value, -1, 1) + 1) * 0.5 * usablePercent
}

const faderTicks = Array.from({ length: 9 }, (_, index) => ({
  id: index,
  top: `${resolveFaderTravelPercentByValue(index / 4 - 1)}%`,
  major: index === 0 || index === 4 || index === 8,
  center: index === 4
}))

const topOverviewRegions = [1, 2, 3]
const bottomOverviewRegions = [6, 7, 8]
const deckHydrateToken = reactive<Record<DeckKey, number>>({
  top: 0,
  bottom: 0
})

const resolveCrossfaderVolumes = (value: number) => {
  const safeValue = clampNumber(value, -1, 1)
  if (safeValue <= 0) {
    return {
      top: 1 + safeValue,
      bottom: 1
    }
  }
  return {
    top: 1,
    bottom: 1 - safeValue
  }
}

const applyCrossfaderVolumes = (value: number) => {
  const volumes = resolveCrossfaderVolumes(value)
  void nativeTransport.setGain('top', volumes.top)
  void nativeTransport.setGain('bottom', volumes.bottom)
}

const syncCrossfaderValue = (value: number) => {
  faderValue.value = clampNumber(value, -1, 1)
  applyCrossfaderVolumes(faderValue.value)
}

const resolveCrossfaderValueByClientY = (clientY: number) => {
  const rect =
    faderRailRef.value?.getBoundingClientRect() || faderRef.value?.getBoundingClientRect()
  if (!rect || rect.height <= 0) return faderValue.value
  const travelInsetPx = rect.height * FADER_TRAVEL_INSET_RATIO
  const travelHeight = Math.max(1, rect.height - travelInsetPx * 2)
  const relativeY = clampNumber(clientY - rect.top - travelInsetPx, 0, travelHeight)
  return (relativeY / travelHeight) * 2 - 1
}

const stopFaderDragging = () => {
  if (!faderDragging.value) return
  faderDragging.value = false
  window.removeEventListener('pointermove', handleWindowFaderPointerMove)
  window.removeEventListener('pointerup', handleWindowFaderPointerUp)
  window.removeEventListener('pointercancel', handleWindowFaderPointerUp)
}

const handleWindowFaderPointerMove = (event: PointerEvent) => {
  if (!faderDragging.value) return
  syncCrossfaderValue(resolveCrossfaderValueByClientY(event.clientY))
}

const handleWindowFaderPointerUp = () => {
  stopFaderDragging()
}

const handleFaderPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) return
  event.preventDefault()
  faderDragging.value = true
  syncCrossfaderValue(resolveCrossfaderValueByClientY(event.clientY))
  window.addEventListener('pointermove', handleWindowFaderPointerMove)
  window.addEventListener('pointerup', handleWindowFaderPointerUp)
  window.addEventListener('pointercancel', handleWindowFaderPointerUp)
}

const handleFaderDoubleClick = () => {
  stopFaderDragging()
  syncCrossfaderValue(0)
}

const faderThumbStyle = computed(() => {
  return {
    top: `${resolveFaderTravelPercentByValue(faderValue.value)}%`
  }
})

const resetRegionDragState = () => {
  hoveredDeckKey.value = null
  for (const key of Object.keys(regionDragDepth)) {
    regionDragDepth[Number(key)] = 0
  }
}

const isSongDrag = (event: DragEvent) =>
  Boolean(event.dataTransfer?.types?.includes('application/x-song-drag'))

const resolveDeckByRegion = (regionId: number): DeckKey => (regionId <= 4 ? 'top' : 'bottom')

const buildSongSnapshot = (filePath: string): ISongInfo => {
  const normalizedPath = String(filePath || '').trim()
  const fileName = normalizedPath.split(/[/\\]/).pop() || ''
  const parts = fileName.split('.')
  const extension = parts.length > 1 ? parts.pop() || '' : ''

  return {
    filePath: normalizedPath,
    fileName,
    fileFormat: extension.toUpperCase(),
    cover: null,
    title: fileName,
    artist: '',
    album: '',
    duration: '',
    genre: '',
    label: '',
    bitrate: undefined,
    container: undefined
  }
}

const resolveDraggedSong = () => {
  const filePath = String(runtime.draggingSongFilePaths?.[0] || '').trim()
  if (!filePath) return null

  const currentSong =
    runtime.songsArea.songInfoArr.find((song) => song.filePath === filePath) ||
    runtime.playingData.playingSongListData.find((song) => song.filePath === filePath)

  if (currentSong) {
    return { ...currentSong }
  }

  return buildSongSnapshot(filePath)
}

const mergeSongWithSharedGrid = (song: ISongInfo, payload: SharedSongGridPayload): ISongInfo => {
  if (!payload) return song
  const filePath = String(payload.filePath || '').trim()
  if (!filePath || filePath !== song.filePath) return song

  let touched = false
  const nextSong: ISongInfo = { ...song }
  if (
    typeof payload.bpm === 'number' &&
    Number.isFinite(payload.bpm) &&
    nextSong.bpm !== payload.bpm
  ) {
    nextSong.bpm = payload.bpm
    touched = true
  }
  if (
    typeof payload.firstBeatMs === 'number' &&
    Number.isFinite(payload.firstBeatMs) &&
    nextSong.firstBeatMs !== payload.firstBeatMs
  ) {
    nextSong.firstBeatMs = payload.firstBeatMs
    touched = true
  }
  if (
    typeof payload.barBeatOffset === 'number' &&
    Number.isFinite(payload.barBeatOffset) &&
    nextSong.barBeatOffset !== payload.barBeatOffset
  ) {
    nextSong.barBeatOffset = payload.barBeatOffset
    touched = true
  }
  return touched ? nextSong : song
}

const setDeckSong = (deck: DeckKey, song: ISongInfo | null) => {
  if (!song) {
    if (deck === 'top') {
      topDeckCuePointSeconds.value = 0
    } else {
      bottomDeckCuePointSeconds.value = 0
    }
  }
  if (deck === 'top') {
    topDeckSong.value = song
    runtime.horizontalBrowseDecks.topSong = song ? { ...song } : null
  } else {
    bottomDeckSong.value = song
    runtime.horizontalBrowseDecks.bottomSong = song ? { ...song } : null
  }
  if (!song) {
    const nowMs = performance.now()
    void commitDeckStatesToNative({
      [deck]: {
        currentSec: 0,
        lastObservedAtMs: nowMs,
        durationSec: 0,
        playing: false,
        playbackRate: 1
      }
    })
  }
}

const resolveDeckSong = (deck: DeckKey) =>
  deck === 'top' ? topDeckSong.value : bottomDeckSong.value
const nativeTransport = createHorizontalBrowseNativeTransport()
const deckSyncState = nativeTransport.state
const topDeckPlaybackRate = computed(() => Number(nativeTransport.state.top.playbackRate) || 1)
const bottomDeckPlaybackRate = computed(
  () => Number(nativeTransport.state.bottom.playbackRate) || 1
)
const topDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('top'))
const bottomDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('bottom'))
const parseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}
const resolveTransportDeckSnapshot = (deck: DeckKey) =>
  deck === 'top' ? nativeTransport.state.top : nativeTransport.state.bottom
const resolveDeckCurrentSeconds = (deck: DeckKey) =>
  Number(resolveTransportDeckSnapshot(deck).currentSec) || 0
const resolveDeckDurationSeconds = (deck: DeckKey) => {
  const explicit = Number(resolveTransportDeckSnapshot(deck).durationSec)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return parseDurationToSeconds(resolveDeckSong(deck)?.duration)
}
const resolveDeckPlaying = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).playing)
const resolveDeckPlaybackRate = (deck: DeckKey) =>
  Number(resolveTransportDeckSnapshot(deck).playbackRate) || 1
const topDeckUiPlaying = computed(() => resolveDeckPlaying('top'))
const bottomDeckUiPlaying = computed(() => resolveDeckPlaying('bottom'))
const syncDeckDefaultCue = (deck: DeckKey, song: ISongInfo | null, force = false) => {
  const target = deck === 'top' ? topDeckCuePointSeconds : bottomDeckCuePointSeconds
  if (!force && target.value > 0.000001) return
  target.value = resolveHorizontalBrowseDefaultCuePointSec(song, resolveDeckDurationSeconds(deck))
}
const resolveDeckToolbarBpmInputValue = (deck: DeckKey) => {
  const toolbarState = deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value
  return deck === 'top'
    ? nativeTransport.state.top.syncEnabled
      ? (Number(nativeTransport.state.top.effectiveBpm) || 0).toFixed(2)
      : toolbarState.bpmInputValue
    : nativeTransport.state.bottom.syncEnabled
      ? (Number(nativeTransport.state.bottom.effectiveBpm) || 0).toFixed(2)
      : toolbarState.bpmInputValue
}
let renderSyncRaf = 0

const buildDeckStateForNative = (deck: DeckKey, override?: DeckTransportStateOverride) => ({
  song: resolveDeckSong(deck),
  currentSec: override?.currentSec ?? resolveDeckCurrentSeconds(deck),
  lastObservedAtMs: override?.lastObservedAtMs ?? performance.now(),
  durationSec: override?.durationSec ?? resolveDeckDurationSeconds(deck),
  playing: override?.playing ?? resolveDeckPlaying(deck),
  playbackRate: override?.playbackRate ?? resolveDeckPlaybackRate(deck)
})

const commitDeckStatesToNative = async (
  overrides?: Partial<Record<DeckKey, DeckTransportStateOverride>>
) => {
  await nativeTransport.setState({
    top: buildDeckStateForNative('top', overrides?.top),
    bottom: buildDeckStateForNative('bottom', overrides?.bottom)
  })
  syncDeckRenderState()
}

const syncNativeTransportNow = async () => {
  await nativeTransport.snapshot(performance.now())
  syncDeckRenderState()
}

const syncDeckRenderState = () => {
  topDeckRenderCurrentSeconds.value = Number(nativeTransport.state.top.renderCurrentSec) || 0
  bottomDeckRenderCurrentSeconds.value = Number(nativeTransport.state.bottom.renderCurrentSec) || 0
}

const stopRenderSyncLoop = () => {
  if (!renderSyncRaf) return
  cancelAnimationFrame(renderSyncRaf)
  renderSyncRaf = 0
}

const startRenderSyncLoop = () => {
  stopRenderSyncLoop()
  const tick = async () => {
    await syncNativeTransportNow().catch(() => {})
    renderSyncRaf = requestAnimationFrame(tick)
  }
  void tick()
}

const hydrateDeckSongSharedGrid = async (deck: DeckKey, song: ISongInfo) => {
  const filePath = String(song.filePath || '').trim()
  if (!filePath) return

  const token = ++deckHydrateToken[deck]
  try {
    const payload = (await window.electron.ipcRenderer.invoke('song:get-shared-grid-definition', {
      filePath
    })) as SharedSongGridPayload
    if (deckHydrateToken[deck] !== token) return
    const currentSong = deck === 'top' ? topDeckSong.value : bottomDeckSong.value
    if (!currentSong || currentSong.filePath !== filePath) return
    const nextSong = mergeSongWithSharedGrid(currentSong, payload)
    if (nextSong !== currentSong) {
      setDeckSong(deck, nextSong)
      syncDeckDefaultCue(deck, nextSong)
      void commitDeckStatesToNative()
    }
  } catch {}
}

const assignSongToDeck = (deck: DeckKey, song: ISongInfo) => {
  const nextSong = { ...song }
  setDeckSong(deck, nextSong)
  syncDeckDefaultCue(deck, nextSong, true)
  const nowMs = performance.now()
  void commitDeckStatesToNative({
    [deck]: {
      currentSec: 0,
      lastObservedAtMs: nowMs,
      durationSec: parseDurationToSeconds(nextSong.duration),
      playing: false,
      playbackRate: 1
    }
  })
  void hydrateDeckSongSharedGrid(deck, nextSong)
}

const resolveDetailRef = (deck: DeckKey) =>
  deck === 'top' ? topDetailRef.value : bottomDetailRef.value

const handleSharedDetailZoomChange = (payload: {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down'
}) => {
  const numeric = Number(payload?.value)
  if (!Number.isFinite(numeric) || numeric <= 0) return
  sharedDetailZoomState.value = {
    value: Math.max(
      HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
      Math.min(HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM, numeric)
    ),
    anchorRatio: Math.max(0, Math.min(1, Number(payload?.anchorRatio) || 0)),
    sourceDirection: payload?.sourceDirection || null,
    revision: sharedDetailZoomState.value.revision + 1
  }
}

const handleToolbarStateChange = (deck: DeckKey, value: DeckToolbarState) => {
  if (deck === 'top') {
    topDeckToolbarState.value = { ...value }
    return
  }
  bottomDeckToolbarState.value = { ...value }
}

const handleDeckBarLinePickingToggle = (deck: DeckKey) => {
  resolveDetailRef(deck)?.toggleBarLinePicking?.()
}

const handleDeckSetBarLineAtPlayhead = (deck: DeckKey) => {
  resolveDetailRef(deck)?.setBarLineAtPlayhead?.()
}

const handleDeckGridShiftLargeLeft = (deck: DeckKey) => {
  resolveDetailRef(deck)?.shiftGridLargeLeft?.()
}

const handleDeckGridShiftSmallLeft = (deck: DeckKey) => {
  resolveDetailRef(deck)?.shiftGridSmallLeft?.()
}

const handleDeckGridShiftSmallRight = (deck: DeckKey) => {
  resolveDetailRef(deck)?.shiftGridSmallRight?.()
}

const handleDeckGridShiftLargeRight = (deck: DeckKey) => {
  resolveDetailRef(deck)?.shiftGridLargeRight?.()
}

const handleDeckBpmInputUpdate = (deck: DeckKey, value: string) => {
  const nextToolbarState = deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value
  const parsed = parsePreviewBpmInput(value)
  if (deck === 'top') {
    topDeckToolbarState.value = { ...nextToolbarState, bpmInputValue: value }
  } else {
    bottomDeckToolbarState.value = { ...nextToolbarState, bpmInputValue: value }
  }
  if (parsed !== null) {
    const currentSong = deck === 'top' ? topDeckSong.value : bottomDeckSong.value
    if (currentSong) {
      const nextSong = { ...currentSong, bpm: parsed }
      setDeckSong(deck, nextSong)
      syncDeckDefaultCue(deck, nextSong)
      void commitDeckStatesToNative()
    }
  }
  resolveDetailRef(deck)?.updateBpmInput?.(value)
}

const handleDeckBpmInputBlur = (deck: DeckKey) => {
  resolveDetailRef(deck)?.blurBpmInput?.()
}

const handleDeckTapBpm = (deck: DeckKey) => {
  resolveDetailRef(deck)?.tapBpm?.()
}

const handleDeckPlayheadSeek = (deck: DeckKey, seconds: number) => {
  void nativeTransport.seek(deck, seconds).then(() => {
    syncDeckRenderState()
  })
}

const handleDeckCue = (deck: DeckKey) => {
  const cueRef = deck === 'top' ? topDeckCuePointSeconds : bottomDeckCuePointSeconds
  const song = resolveDeckSong(deck)
  if (resolveDeckPlaying(deck)) {
    void nativeTransport.setPlaying(deck, false).then(() => {
      void nativeTransport.seek(deck, cueRef.value)
    })
    return
  }
  const nextCuePoint = resolveHorizontalBrowseCuePointSec(
    song,
    resolveDeckCurrentSeconds(deck),
    resolveDeckDurationSeconds(deck)
  )
  cueRef.value = nextCuePoint
  void nativeTransport.seek(deck, nextCuePoint)
}

const handleDeckPlayPauseToggle = (deck: DeckKey) => {
  const nextPlaying = deck === 'top' ? !topDeckUiPlaying.value : !bottomDeckUiPlaying.value
  void nativeTransport.setPlaying(deck, nextPlaying).then(() => {
    syncDeckRenderState()
  })
}

const toggleDeckMaster = async (deck: DeckKey) => {
  await commitDeckStatesToNative()
  await nativeTransport.setLeader(deck)
  syncDeckRenderState()
}

const triggerDeckBeatSync = async (deck: DeckKey) => {
  await commitDeckStatesToNative()
  const snapshot = deck === 'top' ? nativeTransport.state.top : nativeTransport.state.bottom
  if (snapshot.syncEnabled) {
    await nativeTransport.setSyncEnabled(deck, false)
    syncDeckRenderState()
    return
  }
  await nativeTransport.beatsync(deck)
  await nativeTransport.setSyncEnabled(deck, true)
  syncDeckRenderState()
}

const resolveDeckDragDepth = (deck: DeckKey) => {
  if (deck === 'top') {
    return regionDragDepth[1] + regionDragDepth[2] + regionDragDepth[3] + regionDragDepth[4]
  }
  return regionDragDepth[5] + regionDragDepth[6] + regionDragDepth[7] + regionDragDepth[8]
}

const handleRegionDragEnter = (regionId: number, event: DragEvent) => {
  if (!isSongDrag(event)) return
  regionDragDepth[regionId] += 1
  hoveredDeckKey.value = resolveDeckByRegion(regionId)
}

const handleRegionDragOver = (regionId: number, event: DragEvent) => {
  if (!isSongDrag(event)) return
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  hoveredDeckKey.value = resolveDeckByRegion(regionId)
}

const handleRegionDragLeave = (regionId: number, event: DragEvent) => {
  if (!isSongDrag(event)) return
  regionDragDepth[regionId] = Math.max(0, regionDragDepth[regionId] - 1)
  const deck = resolveDeckByRegion(regionId)
  requestAnimationFrame(() => {
    if (resolveDeckDragDepth(deck) === 0 && hoveredDeckKey.value === deck) {
      hoveredDeckKey.value = null
    }
  })
}

const handleRegionDrop = (regionId: number, event: DragEvent) => {
  if (!isSongDrag(event)) return
  const song = resolveDraggedSong()
  resetRegionDragState()
  if (!song) return
  assignSongToDeck(resolveDeckByRegion(regionId), song)
}

const isDeckHovered = (deck: DeckKey) => hoveredDeckKey.value === deck

const handleGlobalDragFinish = () => {
  resetRegionDragState()
}

const handleExternalDeckSongLoad = (payload: HorizontalBrowseLoadSongPayload) => {
  const deck = payload?.deck
  const song = payload?.song
  if (!deck || !song) return
  assignSongToDeck(deck, { ...song })
}

const handleSongGridUpdated = (_event: unknown, payload: SharedSongGridPayload) => {
  const topSong = topDeckSong.value
  if (topSong) {
    const nextTopSong = mergeSongWithSharedGrid(topSong, payload)
    if (nextTopSong !== topSong) {
      setDeckSong('top', nextTopSong)
      syncDeckDefaultCue('top', nextTopSong)
    }
  }

  const bottomSong = bottomDeckSong.value
  if (bottomSong) {
    const nextBottomSong = mergeSongWithSharedGrid(bottomSong, payload)
    if (nextBottomSong !== bottomSong) {
      setDeckSong('bottom', nextBottomSong)
      syncDeckDefaultCue('bottom', nextBottomSong)
    }
  }

  void commitDeckStatesToNative()
}

onMounted(() => {
  syncCrossfaderValue(0)
  void nativeTransport.reset()
  startRenderSyncLoop()
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
})

onUnmounted(() => {
  stopRenderSyncLoop()
  stopFaderDragging()
  window.removeEventListener('drop', handleGlobalDragFinish, true)
  window.removeEventListener('dragend', handleGlobalDragFinish, true)
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
  runtime.horizontalBrowseDecks.topSong = null
  runtime.horizontalBrowseDecks.bottomSong = null
})
</script>

<template>
  <div class="horizontal-shell">
    <div class="controls">
      <div class="deck-controls">
        <button type="button" class="deck-button deck-button--cue" @click="handleDeckCue('top')">
          CUE
        </button>
        <button
          type="button"
          class="deck-button deck-button--play"
          :class="{ 'is-active': topDeckUiPlaying }"
          @click="handleDeckPlayPauseToggle('top')"
        >
          <svg v-if="topDeckUiPlaying" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="4.25" y="3.5" width="2.75" height="9"></rect>
            <rect x="9" y="3.5" width="2.75" height="9"></rect>
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
          </svg>
        </button>
      </div>

      <div
        ref="faderRef"
        class="fader"
        :class="{ 'is-dragging': faderDragging }"
        @pointerdown="handleFaderPointerDown"
        @dblclick.prevent="handleFaderDoubleClick"
      >
        <div class="fader__scale">
          <div class="fader__scale-inner">
            <span
              v-for="tick in faderTicks"
              :key="`left-${tick.id}`"
              class="fader__tick"
              :class="{ 'is-major': tick.major, 'is-center': tick.center }"
              :style="{ top: tick.top }"
            ></span>
          </div>
        </div>
        <div ref="faderRailRef" class="fader__rail">
          <div class="fader__slot"></div>
          <div class="fader__thumb" :style="faderThumbStyle"></div>
        </div>
        <div class="fader__scale">
          <div class="fader__scale-inner">
            <span
              v-for="tick in faderTicks"
              :key="`right-${tick.id}`"
              class="fader__tick"
              :class="{ 'is-major': tick.major, 'is-center': tick.center }"
              :style="{ top: tick.top }"
            ></span>
          </div>
        </div>
      </div>

      <div class="deck-controls">
        <button type="button" class="deck-button deck-button--cue" @click="handleDeckCue('bottom')">
          CUE
        </button>
        <button
          type="button"
          class="deck-button deck-button--play"
          :class="{ 'is-active': bottomDeckUiPlaying }"
          @click="handleDeckPlayPauseToggle('bottom')"
        >
          <svg v-if="bottomDeckUiPlaying" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="4.25" y="3.5" width="2.75" height="9"></rect>
            <rect x="9" y="3.5" width="2.75" height="9"></rect>
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
          </svg>
        </button>
      </div>
    </div>

    <div class="waveform-stack">
      <section class="overview overview--top" :class="{ 'is-deck-hover': isDeckHovered('top') }">
        <div
          v-for="regionId in topOverviewRegions"
          :key="regionId"
          class="overview__region drop-zone"
          :class="{
            'overview__region--deck-info': regionId === 1,
            'overview__region--muted': regionId === 3,
            'overview__region--toolbar': regionId === 3
          }"
          @dragenter.stop.prevent="handleRegionDragEnter(regionId, $event)"
          @dragover.stop.prevent="handleRegionDragOver(regionId, $event)"
          @dragleave.stop="handleRegionDragLeave(regionId, $event)"
          @drop.stop.prevent="handleRegionDrop(regionId, $event)"
        >
          <HorizontalBrowseDeckInfoCard
            v-if="regionId === 1"
            :song="topDeckSong"
            :beat-sync-enabled="deckSyncState.top.syncEnabled"
            :beat-sync-blinking="deckSyncState.top.syncLock === 'tempo-only'"
            :master-active="deckSyncState.leaderDeck === 'top'"
            :current-seconds="topDeckRenderCurrentSeconds"
            :duration-seconds="topDeckDurationSeconds"
            @trigger-beat-sync="triggerDeckBeatSync('top')"
            @toggle-master="toggleDeckMaster('top')"
          />
          <HorizontalBrowseWaveformOverview
            v-else-if="regionId === 2"
            :song="topDeckSong"
            :current-seconds="topDeckRenderCurrentSeconds"
            :duration-seconds="topDeckDurationSeconds"
            @seek="handleDeckPlayheadSeek('top', $event)"
          />
          <div v-else-if="regionId === 3" class="overview__toolbar-row">
            <MixtapeBeatAlignGridAdjustToolbar
              :disabled="topDeckToolbarState.disabled"
              :bpm-input-value="resolveDeckToolbarBpmInputValue('top')"
              :bpm-step="topDeckToolbarState.bpmStep"
              :bpm-min="topDeckToolbarState.bpmMin"
              :bpm-max="topDeckToolbarState.bpmMax"
              @set-bar-line="handleDeckSetBarLineAtPlayhead('top')"
              @shift-left-large="handleDeckGridShiftLargeLeft('top')"
              @shift-left-small="handleDeckGridShiftSmallLeft('top')"
              @shift-right-small="handleDeckGridShiftSmallRight('top')"
              @shift-right-large="handleDeckGridShiftLargeRight('top')"
              @update-bpm-input="handleDeckBpmInputUpdate('top', $event)"
              @blur-bpm-input="handleDeckBpmInputBlur('top')"
              @tap-bpm="handleDeckTapBpm('top')"
            />
            <button
              type="button"
              class="overview__set-bar-btn"
              :class="{ 'is-active': topDeckToolbarState.barLinePicking }"
              :disabled="topDeckToolbarState.disabled"
              @click="handleDeckBarLinePickingToggle('top')"
            >
              {{
                topDeckToolbarState.barLinePicking
                  ? t('mixtape.gridAdjustSetBarLineCancel')
                  : t('mixtape.gridAdjustSetBarLine')
              }}
            </button>
          </div>
        </div>
      </section>

      <section class="detail-pair">
        <div
          class="detail-lane drop-zone"
          :class="{ 'is-deck-hover': isDeckHovered('top') }"
          @dragenter.stop.prevent="handleRegionDragEnter(4, $event)"
          @dragover.stop.prevent="handleRegionDragOver(4, $event)"
          @dragleave.stop="handleRegionDragLeave(4, $event)"
          @drop.stop.prevent="handleRegionDrop(4, $event)"
        >
          <HorizontalBrowseRawWaveformDetail
            ref="topDetailRef"
            :song="topDeckSong"
            :shared-zoom-state="sharedDetailZoomState"
            :current-seconds="topDeckRenderCurrentSeconds"
            :playing="topDeckUiPlaying"
            :playback-rate="topDeckPlaybackRate"
            :cue-seconds="topDeckCuePointSeconds"
            direction="up"
            @toolbar-state-change="handleToolbarStateChange('top', $event)"
            @zoom-change="handleSharedDetailZoomChange"
            @playhead-seek="handleDeckPlayheadSeek('top', $event)"
          />
        </div>

        <div
          class="detail-lane drop-zone"
          :class="{ 'is-deck-hover': isDeckHovered('bottom') }"
          @dragenter.stop.prevent="handleRegionDragEnter(5, $event)"
          @dragover.stop.prevent="handleRegionDragOver(5, $event)"
          @dragleave.stop="handleRegionDragLeave(5, $event)"
          @drop.stop.prevent="handleRegionDrop(5, $event)"
        >
          <HorizontalBrowseRawWaveformDetail
            ref="bottomDetailRef"
            :song="bottomDeckSong"
            :shared-zoom-state="sharedDetailZoomState"
            :current-seconds="bottomDeckRenderCurrentSeconds"
            :playing="bottomDeckUiPlaying"
            :playback-rate="bottomDeckPlaybackRate"
            :cue-seconds="bottomDeckCuePointSeconds"
            direction="down"
            @toolbar-state-change="handleToolbarStateChange('bottom', $event)"
            @zoom-change="handleSharedDetailZoomChange"
            @playhead-seek="handleDeckPlayheadSeek('bottom', $event)"
          />
        </div>
      </section>

      <section
        class="overview overview--bottom"
        :class="{ 'is-deck-hover': isDeckHovered('bottom') }"
      >
        <div
          v-for="regionId in bottomOverviewRegions"
          :key="regionId"
          class="overview__region drop-zone"
          :class="{
            'overview__region--deck-info': regionId === 8,
            'overview__region--muted': regionId === 6,
            'overview__region--toolbar': regionId === 6
          }"
          @dragenter.stop.prevent="handleRegionDragEnter(regionId, $event)"
          @dragover.stop.prevent="handleRegionDragOver(regionId, $event)"
          @dragleave.stop="handleRegionDragLeave(regionId, $event)"
          @drop.stop.prevent="handleRegionDrop(regionId, $event)"
        >
          <div v-if="regionId === 6" class="overview__toolbar-row">
            <MixtapeBeatAlignGridAdjustToolbar
              :disabled="bottomDeckToolbarState.disabled"
              :bpm-input-value="resolveDeckToolbarBpmInputValue('bottom')"
              :bpm-step="bottomDeckToolbarState.bpmStep"
              :bpm-min="bottomDeckToolbarState.bpmMin"
              :bpm-max="bottomDeckToolbarState.bpmMax"
              @set-bar-line="handleDeckSetBarLineAtPlayhead('bottom')"
              @shift-left-large="handleDeckGridShiftLargeLeft('bottom')"
              @shift-left-small="handleDeckGridShiftSmallLeft('bottom')"
              @shift-right-small="handleDeckGridShiftSmallRight('bottom')"
              @shift-right-large="handleDeckGridShiftLargeRight('bottom')"
              @update-bpm-input="handleDeckBpmInputUpdate('bottom', $event)"
              @blur-bpm-input="handleDeckBpmInputBlur('bottom')"
              @tap-bpm="handleDeckTapBpm('bottom')"
            />
            <button
              type="button"
              class="overview__set-bar-btn"
              :class="{ 'is-active': bottomDeckToolbarState.barLinePicking }"
              :disabled="bottomDeckToolbarState.disabled"
              @click="handleDeckBarLinePickingToggle('bottom')"
            >
              {{
                bottomDeckToolbarState.barLinePicking
                  ? t('mixtape.gridAdjustSetBarLineCancel')
                  : t('mixtape.gridAdjustSetBarLine')
              }}
            </button>
          </div>
          <HorizontalBrowseWaveformOverview
            v-else-if="regionId === 7"
            :song="bottomDeckSong"
            :current-seconds="bottomDeckRenderCurrentSeconds"
            :duration-seconds="bottomDeckDurationSeconds"
            @seek="handleDeckPlayheadSeek('bottom', $event)"
          />
          <HorizontalBrowseDeckInfoCard
            v-else-if="regionId === 8"
            :song="bottomDeckSong"
            :beat-sync-enabled="deckSyncState.bottom.syncEnabled"
            :beat-sync-blinking="deckSyncState.bottom.syncLock === 'tempo-only'"
            :master-active="deckSyncState.leaderDeck === 'bottom'"
            :current-seconds="bottomDeckRenderCurrentSeconds"
            :duration-seconds="bottomDeckDurationSeconds"
            @trigger-beat-sync="triggerDeckBeatSync('bottom')"
            @toggle-master="toggleDeckMaster('bottom')"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss" src="./HorizontalBrowseModeShell.scss"></style>
