<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckButtons from '@renderer/components/HorizontalBrowseDeckButtons.vue'
import HorizontalBrowseDeckDetailLane from '@renderer/components/HorizontalBrowseDeckDetailLane.vue'
import HorizontalBrowseDeckMoveDialog from '@renderer/components/HorizontalBrowseDeckMoveDialog.vue'
import HorizontalBrowseDeckOverviewSection from '@renderer/components/HorizontalBrowseDeckOverviewSection.vue'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
} from '@renderer/components/horizontalBrowseWaveform.constants'
import {
  buildHorizontalBrowseDeckToolbarState,
  parseHorizontalBrowseDurationToSeconds,
  resolveHorizontalBrowseDeckDurationSeconds,
  resolveHorizontalBrowseDeckGridBpm,
  resolveHorizontalBrowseDeckSyncUiEnabled,
  resolveHorizontalBrowseDeckSyncUiLock
} from '@renderer/components/horizontalBrowseShellState'
import {
  buildHorizontalBrowseSongSnapshot,
  isSameHorizontalBrowseSongFilePath,
  mergeHorizontalBrowseSongWithSharedGrid
} from '@renderer/components/horizontalBrowseShellSongs'
import { formatPreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { createHorizontalBrowseNativeTransport } from '@renderer/components/horizontalBrowseNativeTransport'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec
} from '@renderer/components/horizontalBrowseDetailMath'
import { createHorizontalBrowseDeckEjectHandler } from '@renderer/components/useHorizontalBrowseDeckEject'
import { useHorizontalBrowseDeckDelete } from '@renderer/components/useHorizontalBrowseDeckDelete'
import { useHorizontalBrowseDeckMove } from '@renderer/components/useHorizontalBrowseDeckMove'
import { useHorizontalBrowseDeckSongs } from '@renderer/components/useHorizontalBrowseDeckSongs'
import { useHorizontalBrowseHotkeys } from '@renderer/components/useHorizontalBrowseHotkeys'
import { useHorizontalBrowseDeckTempoControls } from '@renderer/components/useHorizontalBrowseDeckTempoControls'
import { useHorizontalBrowseDeckToolbarInteractions } from '@renderer/components/useHorizontalBrowseDeckToolbarInteractions'
import { useHorizontalBrowseDeckTransportInteractions } from '@renderer/components/useHorizontalBrowseDeckTransportInteractions'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'
import emitter from '@renderer/utils/mitt'

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
type DeckTransportStateOverride = Partial<{
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}>

type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}
type HorizontalBrowseDeckDetailLaneExpose = {
  toggleBarLinePicking?: () => void
  setBarLineAtPlayhead?: () => void
  shiftGridLargeLeft?: () => void
  shiftGridSmallLeft?: () => void
  shiftGridSmallRight?: () => void
  shiftGridLargeRight?: () => void
  toggleMetronome?: () => void
  cycleMetronomeVolume?: () => void
}

const createDefaultDeckToolbarState = () => ({
  disabled: true,
  bpmInputValue: '',
  bpmStep: 0.01,
  bpmMin: 1,
  bpmMax: 300,
  barLinePicking: false,
  metronomeEnabled: false,
  metronomeVolumeLevel: 2 as 1 | 2 | 3,
  canToggleMetronome: false,
  canAdjustMetronomeVolume: false
})
const FADER_TRAVEL_INSET_RATIO = 0.17
const CROSSFADER_KEY_STEP = 0.25

const runtime = useRuntimeStore()
const {
  topDeckSong,
  bottomDeckSong,
  setDeckSong: setDeckSongState,
  resolveDeckSong
} = useHorizontalBrowseDeckSongs()
const topDeckCuePointSeconds = ref(0)
const bottomDeckCuePointSeconds = ref(0)
const topDetailRef = ref<HorizontalBrowseDeckDetailLaneExpose | null>(null)
const bottomDetailRef = ref<HorizontalBrowseDeckDetailLaneExpose | null>(null)
const faderRef = ref<HTMLElement | null>(null)
const faderRailRef = ref<HTMLElement | null>(null)
const topDeckToolbarState = ref(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref(createDefaultDeckToolbarState())
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

const setDeckSong = (deck: DeckKey, song: ISongInfo | null) => {
  deckTempoInputDirty[deck] = false
  if (!song) {
    if (deck === 'top') {
      topDeckCuePointSeconds.value = 0
    } else {
      bottomDeckCuePointSeconds.value = 0
    }
  }
  setDeckSongState(deck, song)
}

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
const deckTempoInputDirty = reactive<Record<DeckKey, boolean>>({
  top: false,
  bottom: false
})
const deckTempoCommitToken = reactive<Record<DeckKey, number>>({
  top: 0,
  bottom: 0
})
const deckInteractionOrder = reactive<Record<DeckKey, number>>({
  top: 0,
  bottom: 0
})
const deckRecentInteraction = reactive<Record<DeckKey, boolean>>({
  top: false,
  bottom: false
})
const DECK_RECENT_INTERACTION_WINDOW_MS = 4000
let nextDeckInteractionOrder = 0
let topDeckRecentInteractionTimer: ReturnType<typeof setTimeout> | null = null
let bottomDeckRecentInteractionTimer: ReturnType<typeof setTimeout> | null = null

const clearDeckRecentInteractionTimer = (deck: DeckKey) => {
  const currentTimer =
    deck === 'top' ? topDeckRecentInteractionTimer : bottomDeckRecentInteractionTimer
  if (!currentTimer) return
  clearTimeout(currentTimer)
  if (deck === 'top') {
    topDeckRecentInteractionTimer = null
    return
  }
  bottomDeckRecentInteractionTimer = null
}

const touchDeckInteraction = (deck: DeckKey) => {
  const interactionOrder = ++nextDeckInteractionOrder
  deckInteractionOrder[deck] = interactionOrder
  deckRecentInteraction[deck] = true
  clearDeckRecentInteractionTimer(deck)
  const timer = setTimeout(() => {
    if (deckInteractionOrder[deck] !== interactionOrder) return
    deckRecentInteraction[deck] = false
    if (deck === 'top') {
      topDeckRecentInteractionTimer = null
      return
    }
    bottomDeckRecentInteractionTimer = null
  }, DECK_RECENT_INTERACTION_WINDOW_MS)
  if (deck === 'top') {
    topDeckRecentInteractionTimer = timer
    return
  }
  bottomDeckRecentInteractionTimer = timer
}

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

const resolveDraggedSong = () => {
  const filePath = String(runtime.draggingSongFilePaths?.[0] || '').trim()
  if (!filePath) return null

  const currentSong =
    runtime.songsArea.songInfoArr.find((song) => song.filePath === filePath) ||
    runtime.playingData.playingSongListData.find((song) => song.filePath === filePath)

  if (currentSong) {
    return { ...currentSong }
  }

  return buildHorizontalBrowseSongSnapshot(filePath)
}

const nativeTransport = createHorizontalBrowseNativeTransport()
const deckSyncState = nativeTransport.state
const topDeckPlaybackRate = computed(() => Number(nativeTransport.state.top.playbackRate) || 1)
const bottomDeckPlaybackRate = computed(
  () => Number(nativeTransport.state.bottom.playbackRate) || 1
)
const topDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('top'))
const bottomDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('bottom'))
const resolveTransportDeckSnapshot = (deck: DeckKey) =>
  deck === 'top' ? nativeTransport.state.top : nativeTransport.state.bottom
const resolveDeckCuePointRef = (deck: DeckKey) =>
  deck === 'top' ? topDeckCuePointSeconds : bottomDeckCuePointSeconds
const resolveDeckCurrentSeconds = (deck: DeckKey) =>
  Number(resolveTransportDeckSnapshot(deck).currentSec) || 0
const resolveDeckRenderCurrentSeconds = (deck: DeckKey) =>
  deck === 'top' ? topDeckRenderCurrentSeconds.value : bottomDeckRenderCurrentSeconds.value
const resolveDeckDurationSeconds = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckDurationSeconds(
    resolveTransportDeckSnapshot(deck).durationSec,
    resolveDeckSong(deck)?.duration
  )
const resolveDeckPlaying = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).playing)
const resolveDeckLoaded = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).loaded)
const resolveDeckDecoding = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).decoding)
const resolveDeckPlaybackRate = (deck: DeckKey) =>
  Number(resolveTransportDeckSnapshot(deck).playbackRate) || 1
const topDeckUiPlaying = computed(() => resolveDeckPlaying('top'))
const bottomDeckUiPlaying = computed(() => resolveDeckPlaying('bottom'))
const topDeckShouldDeferWaveformLoad = computed(
  () => bottomDeckUiPlaying.value && !topDeckUiPlaying.value
)
const bottomDeckShouldDeferWaveformLoad = computed(
  () => topDeckUiPlaying.value && !bottomDeckUiPlaying.value
)
const resolveDeckGridBpm = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckGridBpm(
    resolveTransportDeckSnapshot(deck).effectiveBpm,
    resolveTransportDeckSnapshot(deck).playbackRate,
    resolveDeckSong(deck)?.bpm
  )
const topDeckGridBpm = computed(() => resolveDeckGridBpm('top'))
const bottomDeckGridBpm = computed(() => resolveDeckGridBpm('bottom'))
const deckKeysHarmonicMatched = computed(() =>
  isHarmonicMixCompatible(
    String(topDeckSong.value?.key || ''),
    String(bottomDeckSong.value?.key || '')
  )
)
const syncDeckDefaultCue = (deck: DeckKey, song: ISongInfo | null, force = false) => {
  const target = resolveDeckCuePointRef(deck)
  if (!force && target.value > 0.000001) return
  target.value = resolveHorizontalBrowseDefaultCuePointSec(song, resolveDeckDurationSeconds(deck))
}
const resolveDeckToolbarBpmInputValue = (deck: DeckKey) => {
  const toolbarState = deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value
  if (deckTempoInputDirty[deck]) {
    return toolbarState.bpmInputValue
  }
  const effectiveBpm = Number(resolveTransportDeckSnapshot(deck).effectiveBpm)
  if (Number.isFinite(effectiveBpm) && effectiveBpm > 0) {
    return formatPreviewBpm(effectiveBpm)
  }
  const baseGridBpm = Number(resolveDeckGridBpm(deck))
  if (Number.isFinite(baseGridBpm) && baseGridBpm > 0) {
    return formatPreviewBpm(baseGridBpm)
  }
  return toolbarState.bpmInputValue
}
let renderSyncRaf = 0

const buildDeckStateForNative = (deck: DeckKey, override?: DeckTransportStateOverride) => ({
  song: resolveDeckSong(deck),
  currentSec: override?.currentSec ?? resolveDeckCurrentSeconds(deck),
  lastObservedAtMs: override?.lastObservedAtMs ?? performance.now(),
  durationSec: override?.durationSec ?? resolveDeckDurationSeconds(deck),
  playing: override?.playing ?? resolveDeckPlaying(deck),
  playbackRate: override?.playbackRate ?? resolveDeckPlaybackRate(deck),
  masterTempoEnabled: override?.masterTempoEnabled ?? isDeckMasterTempoEnabled(deck)
})

const commitDeckStateToNative = async (deck: DeckKey, override?: DeckTransportStateOverride) => {
  await nativeTransport.setDeckState(deck, buildDeckStateForNative(deck, override))
  syncDeckRenderState()
}

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
    handleDeckLoopPlaybackTick('top')
    handleDeckLoopPlaybackTick('bottom')
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
    const nextSong = mergeHorizontalBrowseSongWithSharedGrid(currentSong, payload)
    if (nextSong !== currentSong) {
      setDeckSong(deck, nextSong)
      syncDeckDefaultCue(deck, nextSong)
      void commitDeckStateToNative(deck)
    }
  } catch {}
}

const queueDeckSongPriorityAnalysis = (deck: DeckKey, song: ISongInfo | null | undefined) => {
  const filePath = String(song?.filePath || '').trim()
  if (!filePath) return
  window.electron.ipcRenderer.send('key-analysis:queue-playing', {
    filePath,
    focusSlot: `horizontal-browse-${deck}`
  })
}

const resolveDeckSongWithSharedGrid = async (song: ISongInfo) => {
  const filePath = String(song.filePath || '').trim()
  if (!filePath) return { ...song }
  try {
    const payload = (await window.electron.ipcRenderer.invoke('song:get-shared-grid-definition', {
      filePath
    })) as SharedSongGridPayload
    return mergeHorizontalBrowseSongWithSharedGrid({ ...song }, payload)
  } catch {
    return { ...song }
  }
}

const assignSongToDeck = async (deck: DeckKey, song: ISongInfo) => {
  touchDeckInteraction(deck)
  deckPendingPlayOnLoad[deck] = false
  const nextSong = await resolveDeckSongWithSharedGrid(song)
  setDeckSong(deck, nextSong)
  queueDeckSongPriorityAnalysis(deck, nextSong)
  syncDeckDefaultCue(deck, nextSong, true)
  const nowMs = performance.now()
  void commitDeckStateToNative(deck, {
    currentSec: 0,
    lastObservedAtMs: nowMs,
    durationSec: parseHorizontalBrowseDurationToSeconds(nextSong.duration),
    playing: false,
    playbackRate: 1
  })
}

const {
  selectSongListDialogVisible,
  selectSongListDialogTargetLibraryName,
  isDeckSongReadOnly,
  openDeckMoveDialog,
  handleDeckMoveSong,
  handleDeckMoveDialogCancel
} = useHorizontalBrowseDeckMove({
  getDeckSong: resolveDeckSong,
  setDeckSong
})

const { isDeckMasterTempoEnabled, toggleDeckMasterTempo, setDeckTargetBpm, resetDeckTempo } =
  useHorizontalBrowseDeckTempoControls({
    resolveDeckSong,
    resolveDeckGridBpm,
    resolveTransportDeckSnapshot,
    nativeTransport,
    commitDeckStateToNative
  })

const handleDeckMasterTempoToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckMasterTempo(deck)
  void commitDeckStateToNative(deck, {
    masterTempoEnabled: isDeckMasterTempoEnabled(deck)
  })
}

const {
  deckPendingPlayOnLoad,
  suppressDeckCueClick,
  isDeckWaveformDragging,
  resolveDeckCuePreviewRuntimeState,
  resolveDeckLoopRange,
  resolveDeckLoopBeatLabel,
  resolveDeckLoopDisabled,
  isDeckLoopActive,
  handleDeckLoopToggle,
  handleDeckLoopStepDown,
  handleDeckLoopStepUp,
  handleDeckLoopPlaybackTick,
  handleDeckRawWaveformDragStart,
  handleDeckRawWaveformDragEnd,
  handleDeckPlayheadSeek,
  handleDeckBarJump,
  handleDeckSeekPercent,
  stopAllDeckCuePreview,
  handleWindowDeckCuePointerUp,
  handleDeckCuePointerDown,
  handleDeckCueClick,
  handleDeckCueHotkeyDown,
  handleDeckCueHotkeyUp,
  handleDeckPlayPauseToggle
} = useHorizontalBrowseDeckTransportInteractions({
  touchDeckInteraction,
  nativeTransport,
  syncDeckRenderState,
  commitDeckStateToNative,
  commitDeckStatesToNative,
  resolveDeckSong,
  resolveDeckGridBpm,
  resolveDeckDurationSeconds,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckPlaying,
  resolveDeckLoaded,
  resolveDeckDecoding,
  resolveTransportDeckSnapshot,
  resolveDeckCuePointRef,
  resolveCuePointSec: resolveHorizontalBrowseCuePointSec
})

const handleDeckEjectSong = createHorizontalBrowseDeckEjectHandler({
  resolveDeckCuePreviewRuntimeState,
  resolveTransportDeckSnapshot,
  nativeTransport,
  setDeckSong,
  commitDeckStateToNative,
  suppressDeckCueClick
})

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

const {
  handleToolbarStateChange,
  handleDeckBarLinePickingToggle,
  handleDeckSetBarLineAtPlayhead,
  handleDeckGridShiftLargeLeft,
  handleDeckGridShiftSmallLeft,
  handleDeckGridShiftSmallRight,
  handleDeckGridShiftLargeRight,
  handleDeckMetronomeToggle,
  handleDeckMetronomeVolumeCycle,
  handleDeckBpmInputUpdate,
  handleDeckBpmInputBlur
} = useHorizontalBrowseDeckToolbarInteractions({
  topDeckToolbarState,
  bottomDeckToolbarState,
  deckTempoInputDirty,
  deckTempoCommitToken,
  touchDeckInteraction,
  resolveDetailRef,
  resolveDeckToolbarBpmInputValue,
  setDeckTargetBpm
})

const resolveDeckSyncUiEnabled = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckSyncUiEnabled(
    Boolean(resolveDeckSong(deck)),
    resolveTransportDeckSnapshot(deck).syncEnabled,
    resolveDeckCuePreviewRuntimeState(deck).active,
    resolveDeckCuePreviewRuntimeState(deck).syncEnabledBefore
  )

const resolveDeckSyncUiLock = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckSyncUiLock(
    Boolean(resolveDeckSong(deck)),
    resolveTransportDeckSnapshot(deck).syncLock,
    resolveDeckCuePreviewRuntimeState(deck).active,
    resolveDeckCuePreviewRuntimeState(deck).syncEnabledBefore,
    resolveDeckCuePreviewRuntimeState(deck).syncLockBefore
  )

const resolveDeckRawLoadPriorityHint = (deck: DeckKey) => {
  const recentBoost = deckRecentInteraction[deck] ? 1_000_000 : 0
  const dragBoost = isDeckWaveformDragging(deck) ? 2_000_000 : 0
  const cuePreviewBoost = resolveDeckCuePreviewRuntimeState(deck).active ? 1_500_000 : 0
  const playingBoost = resolveDeckPlaying(deck) ? 500_000 : 0
  const loadedBoost = resolveDeckSong(deck) ? 100_000 : 0
  return (
    dragBoost +
    cuePreviewBoost +
    recentBoost +
    playingBoost +
    loadedBoost +
    deckInteractionOrder[deck]
  )
}

const topDeckRawLoadPriorityHint = computed(() => resolveDeckRawLoadPriorityHint('top'))
const bottomDeckRawLoadPriorityHint = computed(() => resolveDeckRawLoadPriorityHint('bottom'))

const resolveDeckToolbarState = (deck: DeckKey) =>
  buildHorizontalBrowseDeckToolbarState(
    deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value,
    resolveDeckToolbarBpmInputValue(deck),
    {
      loopBeatLabel: resolveDeckLoopBeatLabel(deck),
      loopActive: isDeckLoopActive(deck),
      loopDisabled: resolveDeckLoopDisabled(deck)
    }
  )

const toggleDeckMaster = async (deck: DeckKey) => {
  touchDeckInteraction(deck)
  await commitDeckStatesToNative()
  await nativeTransport.setLeader(deck)
  syncDeckRenderState()
}

const triggerDeckBeatSync = async (deck: DeckKey) => {
  touchDeckInteraction(deck)
  await commitDeckStatesToNative()
  const snapshot = deck === 'top' ? nativeTransport.state.top : nativeTransport.state.bottom
  if (snapshot.syncEnabled) {
    await nativeTransport.setSyncEnabled(deck, false)
    syncDeckRenderState()
    return
  }
  await nativeTransport.setSyncEnabled(deck, true)
  if (resolveDeckPlaying(deck)) {
    await nativeTransport.beatsync(deck)
  }
  syncDeckRenderState()
}

const handleCrossfaderNudgeByKeyboard = (direction: -1 | 1) => {
  syncCrossfaderValue(faderValue.value + direction * CROSSFADER_KEY_STEP)
}

const handleCrossfaderResetByKeyboard = () => {
  syncCrossfaderValue(0)
}

const handleDeckMoveToFilterHotkey = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  openDeckMoveDialog(deck, 'FilterLibrary')
}

const handleDeckMoveToCuratedHotkey = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  openDeckMoveDialog(deck, 'CuratedLibrary')
}

const { deleteDeckSong } = useHorizontalBrowseDeckDelete({
  runtime,
  getDeckSong: resolveDeckSong,
  ejectDeckSong: handleDeckEjectSong
})

const handleDeckDeleteHotkey = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  void deleteDeckSong(deck)
}

useHorizontalBrowseHotkeys({
  runtime,
  onTogglePlayPause: handleDeckPlayPauseToggle,
  onCueKeyDown: handleDeckCueHotkeyDown,
  onCueKeyUp: handleDeckCueHotkeyUp,
  onJumpBar: handleDeckBarJump,
  onMoveToFilter: handleDeckMoveToFilterHotkey,
  onMoveToCurated: handleDeckMoveToCuratedHotkey,
  onDelete: handleDeckDeleteHotkey,
  onSeekPercent: handleDeckSeekPercent,
  onNudgeCrossfader: handleCrossfaderNudgeByKeyboard,
  onResetCrossfader: handleCrossfaderResetByKeyboard
})

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
  void assignSongToDeck(resolveDeckByRegion(regionId), song)
}

const isDeckHovered = (deck: DeckKey) => hoveredDeckKey.value === deck

const handleGlobalDragFinish = () => {
  resetRegionDragState()
}

const handleExternalDeckSongLoad = (payload: HorizontalBrowseLoadSongPayload) => {
  const deck = payload?.deck
  const song = payload?.song
  if (!deck || !song) return
  void assignSongToDeck(deck, { ...song })
}

const handleSongGridUpdated = (_event: unknown, payload: SharedSongGridPayload) => {
  const topSong = topDeckSong.value
  if (topSong) {
    const nextTopSong = mergeHorizontalBrowseSongWithSharedGrid(topSong, payload)
    if (nextTopSong !== topSong) {
      setDeckSong('top', nextTopSong)
      syncDeckDefaultCue('top', nextTopSong)
    }
  }

  const bottomSong = bottomDeckSong.value
  if (bottomSong) {
    const nextBottomSong = mergeHorizontalBrowseSongWithSharedGrid(bottomSong, payload)
    if (nextBottomSong !== bottomSong) {
      setDeckSong('bottom', nextBottomSong)
      syncDeckDefaultCue('bottom', nextBottomSong)
    }
  }

  void commitDeckStatesToNative()
}

const handleSongKeyUpdated = (
  _event: unknown,
  payload: { filePath?: string; keyText?: string }
) => {
  const filePath = String(payload?.filePath || '').trim()
  const keyText = String(payload?.keyText || '').trim()
  if (!filePath || !keyText) return

  const patchDeckSongKey = (deck: DeckKey) => {
    const currentSong = resolveDeckSong(deck)
    if (!currentSong) return
    if (!isSameHorizontalBrowseSongFilePath(currentSong.filePath, filePath)) return
    if (String(currentSong.key || '').trim() === keyText) return
    setDeckSong(deck, {
      ...currentSong,
      key: keyText
    })
  }

  patchDeckSongKey('top')
  patchDeckSongKey('bottom')
}

watch(
  () => deckSyncState.leaderDeck,
  (leaderDeck) => {
    runtime.horizontalBrowseDecks.leaderDeck =
      leaderDeck === 'top' || leaderDeck === 'bottom' ? leaderDeck : null
  },
  { immediate: true }
)

onMounted(() => {
  syncCrossfaderValue(0)
  void nativeTransport.reset()
  startRenderSyncLoop()
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  window.addEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.addEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.addEventListener('blur', stopAllDeckCuePreview)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.on('song-key-updated', handleSongKeyUpdated)
})

onUnmounted(() => {
  stopAllDeckCuePreview()
  stopRenderSyncLoop()
  stopFaderDragging()
  clearDeckRecentInteractionTimer('top')
  clearDeckRecentInteractionTimer('bottom')
  window.removeEventListener('drop', handleGlobalDragFinish, true)
  window.removeEventListener('dragend', handleGlobalDragFinish, true)
  window.removeEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.removeEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.removeEventListener('blur', stopAllDeckCuePreview)
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.removeListener('song-key-updated', handleSongKeyUpdated)
  runtime.horizontalBrowseDecks.topSong = null
  runtime.horizontalBrowseDecks.bottomSong = null
  runtime.horizontalBrowseDecks.leaderDeck = null
})
</script>

<template>
  <div class="horizontal-shell">
    <div class="controls">
      <HorizontalBrowseDeckButtons
        :playing="topDeckUiPlaying"
        @cue-pointer-down="handleDeckCuePointerDown('top', $event)"
        @cue-click="handleDeckCueClick('top')"
        @play-toggle="handleDeckPlayPauseToggle('top')"
      />

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

      <HorizontalBrowseDeckButtons
        :playing="bottomDeckUiPlaying"
        @cue-pointer-down="handleDeckCuePointerDown('bottom', $event)"
        @cue-click="handleDeckCueClick('bottom')"
        @play-toggle="handleDeckPlayPauseToggle('bottom')"
      />
    </div>

    <div class="waveform-stack">
      <HorizontalBrowseDeckOverviewSection
        position="top"
        :region-ids="topOverviewRegions"
        deck="top"
        :deck-hovered="isDeckHovered('top')"
        :song="topDeckSong"
        :beat-sync-enabled="topDeckSong ? resolveDeckSyncUiEnabled('top') : false"
        :beat-sync-blinking="topDeckSong ? resolveDeckSyncUiLock('top') === 'tempo-only' : false"
        :master-active="topDeckSong ? deckSyncState.leaderDeck === 'top' : false"
        :key-highlighted="deckKeysHarmonicMatched"
        :current-seconds="topDeckRenderCurrentSeconds"
        :duration-seconds="topDeckDurationSeconds"
        :toolbar-state="resolveDeckToolbarState('top')"
        :loop-range="resolveDeckLoopRange('top')"
        :read-only-source="isDeckSongReadOnly('top')"
        :master-tempo-enabled="isDeckMasterTempoEnabled('top')"
        @region-drag-enter="handleRegionDragEnter"
        @region-drag-over="handleRegionDragOver"
        @region-drag-leave="handleRegionDragLeave"
        @region-drop="handleRegionDrop"
        @trigger-beat-sync="triggerDeckBeatSync('top')"
        @toggle-master="toggleDeckMaster('top')"
        @eject-song="handleDeckEjectSong('top')"
        @seek="handleDeckPlayheadSeek('top', $event)"
        @set-bar-line="handleDeckSetBarLineAtPlayhead('top')"
        @shift-left-large="handleDeckGridShiftLargeLeft('top')"
        @shift-left-small="handleDeckGridShiftSmallLeft('top')"
        @shift-right-small="handleDeckGridShiftSmallRight('top')"
        @shift-right-large="handleDeckGridShiftLargeRight('top')"
        @update-bpm-input="handleDeckBpmInputUpdate('top', $event)"
        @blur-bpm-input="handleDeckBpmInputBlur('top')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('top')"
        @toggle-metronome="handleDeckMetronomeToggle('top')"
        @cycle-metronome-volume="handleDeckMetronomeVolumeCycle('top')"
        @loop-step-down="handleDeckLoopStepDown('top')"
        @loop-step-up="handleDeckLoopStepUp('top')"
        @toggle-loop="handleDeckLoopToggle('top')"
        @toggle-master-tempo="handleDeckMasterTempoToggle('top')"
        @reset-tempo="resetDeckTempo('top')"
        @select-move-target="openDeckMoveDialog('top', $event)"
      />

      <section class="detail-pair">
        <HorizontalBrowseDeckDetailLane
          ref="topDetailRef"
          :song="topDeckSong"
          :shared-zoom-state="sharedDetailZoomState"
          :current-seconds="topDeckRenderCurrentSeconds"
          :playing="topDeckUiPlaying"
          :playback-rate="topDeckPlaybackRate"
          :grid-bpm="topDeckGridBpm"
          :loop-range="resolveDeckLoopRange('top')"
          :cue-seconds="topDeckCuePointSeconds"
          :defer-waveform-load="topDeckShouldDeferWaveformLoad"
          :raw-load-priority-hint="topDeckRawLoadPriorityHint"
          direction="up"
          :deck-hovered="isDeckHovered('top')"
          :region-id="4"
          @region-drag-enter="handleRegionDragEnter"
          @region-drag-over="handleRegionDragOver"
          @region-drag-leave="handleRegionDragLeave"
          @region-drop="handleRegionDrop"
          @toolbar-state-change="handleToolbarStateChange('top', $event)"
          @zoom-change="handleSharedDetailZoomChange"
          @drag-session-start="handleDeckRawWaveformDragStart('top')"
          @drag-session-end="handleDeckRawWaveformDragEnd('top', $event)"
        />

        <HorizontalBrowseDeckDetailLane
          ref="bottomDetailRef"
          :song="bottomDeckSong"
          :shared-zoom-state="sharedDetailZoomState"
          :current-seconds="bottomDeckRenderCurrentSeconds"
          :playing="bottomDeckUiPlaying"
          :playback-rate="bottomDeckPlaybackRate"
          :grid-bpm="bottomDeckGridBpm"
          :loop-range="resolveDeckLoopRange('bottom')"
          :cue-seconds="bottomDeckCuePointSeconds"
          :defer-waveform-load="bottomDeckShouldDeferWaveformLoad"
          :raw-load-priority-hint="bottomDeckRawLoadPriorityHint"
          direction="down"
          :deck-hovered="isDeckHovered('bottom')"
          :region-id="5"
          @region-drag-enter="handleRegionDragEnter"
          @region-drag-over="handleRegionDragOver"
          @region-drag-leave="handleRegionDragLeave"
          @region-drop="handleRegionDrop"
          @toolbar-state-change="handleToolbarStateChange('bottom', $event)"
          @zoom-change="handleSharedDetailZoomChange"
          @drag-session-start="handleDeckRawWaveformDragStart('bottom')"
          @drag-session-end="handleDeckRawWaveformDragEnd('bottom', $event)"
        />
      </section>

      <HorizontalBrowseDeckOverviewSection
        position="bottom"
        :region-ids="bottomOverviewRegions"
        deck="bottom"
        :deck-hovered="isDeckHovered('bottom')"
        :song="bottomDeckSong"
        :beat-sync-enabled="bottomDeckSong ? resolveDeckSyncUiEnabled('bottom') : false"
        :beat-sync-blinking="
          bottomDeckSong ? resolveDeckSyncUiLock('bottom') === 'tempo-only' : false
        "
        :master-active="bottomDeckSong ? deckSyncState.leaderDeck === 'bottom' : false"
        :key-highlighted="deckKeysHarmonicMatched"
        :current-seconds="bottomDeckRenderCurrentSeconds"
        :duration-seconds="bottomDeckDurationSeconds"
        :toolbar-state="resolveDeckToolbarState('bottom')"
        :loop-range="resolveDeckLoopRange('bottom')"
        :read-only-source="isDeckSongReadOnly('bottom')"
        :master-tempo-enabled="isDeckMasterTempoEnabled('bottom')"
        @region-drag-enter="handleRegionDragEnter"
        @region-drag-over="handleRegionDragOver"
        @region-drag-leave="handleRegionDragLeave"
        @region-drop="handleRegionDrop"
        @trigger-beat-sync="triggerDeckBeatSync('bottom')"
        @toggle-master="toggleDeckMaster('bottom')"
        @eject-song="handleDeckEjectSong('bottom')"
        @seek="handleDeckPlayheadSeek('bottom', $event)"
        @set-bar-line="handleDeckSetBarLineAtPlayhead('bottom')"
        @shift-left-large="handleDeckGridShiftLargeLeft('bottom')"
        @shift-left-small="handleDeckGridShiftSmallLeft('bottom')"
        @shift-right-small="handleDeckGridShiftSmallRight('bottom')"
        @shift-right-large="handleDeckGridShiftLargeRight('bottom')"
        @update-bpm-input="handleDeckBpmInputUpdate('bottom', $event)"
        @blur-bpm-input="handleDeckBpmInputBlur('bottom')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('bottom')"
        @toggle-metronome="handleDeckMetronomeToggle('bottom')"
        @cycle-metronome-volume="handleDeckMetronomeVolumeCycle('bottom')"
        @loop-step-down="handleDeckLoopStepDown('bottom')"
        @loop-step-up="handleDeckLoopStepUp('bottom')"
        @toggle-loop="handleDeckLoopToggle('bottom')"
        @toggle-master-tempo="handleDeckMasterTempoToggle('bottom')"
        @reset-tempo="resetDeckTempo('bottom')"
        @select-move-target="openDeckMoveDialog('bottom', $event)"
      />
    </div>

    <HorizontalBrowseDeckMoveDialog
      :visible="selectSongListDialogVisible"
      :library-name="selectSongListDialogTargetLibraryName"
      @confirm="handleDeckMoveSong"
      @cancel="handleDeckMoveDialogCancel"
    />
  </div>
</template>

<style scoped lang="scss" src="./HorizontalBrowseModeShell.scss"></style>
