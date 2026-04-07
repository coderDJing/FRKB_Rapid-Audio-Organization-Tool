<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
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
import { parsePreviewBpmInput } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { createHorizontalBrowseNativeTransport } from '@renderer/components/horizontalBrowseNativeTransport'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec
} from '@renderer/components/horizontalBrowseDetailMath'
import { createHorizontalBrowseDeckEjectHandler } from '@renderer/components/useHorizontalBrowseDeckEject'
import { useHorizontalBrowseDeckMove } from '@renderer/components/useHorizontalBrowseDeckMove'
import { useHorizontalBrowseDeckSongs } from '@renderer/components/useHorizontalBrowseDeckSongs'
import { useRuntimeStore } from '@renderer/stores/runtime'
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
}>

type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}
type DeckCuePreviewState = {
  active: boolean
  pointerId: number | null
  cueSeconds: number
  syncEnabledBefore: boolean
  syncLockBefore: string
  token: number
}

type DeckWaveformDragState = {
  active: boolean
  wasPlaying: boolean
  syncEnabledBefore: boolean
  token: number
}

type DeckWaveformDragEndPayload = {
  anchorSec: number
  committed: boolean
}

const createDefaultDeckToolbarState = () => ({
  disabled: true,
  bpmInputValue: '128.00',
  bpmStep: 0.01,
  bpmMin: 1,
  bpmMax: 300,
  barLinePicking: false
})
const createDefaultDeckCuePreviewState = (): DeckCuePreviewState => ({
  active: false,
  pointerId: null,
  cueSeconds: 0,
  syncEnabledBefore: false,
  syncLockBefore: 'off',
  token: 0
})
const createDefaultDeckWaveformDragState = (): DeckWaveformDragState => ({
  active: false,
  wasPlaying: false,
  syncEnabledBefore: false,
  token: 0
})
const FADER_TRAVEL_INSET_RATIO = 0.17
const CUE_POINT_TRIGGER_EPSILON_SEC = 0.05

const runtime = useRuntimeStore()
const {
  topDeckSong,
  bottomDeckSong,
  setDeckSong: setDeckSongState,
  resolveDeckSong
} = useHorizontalBrowseDeckSongs()
const topDeckCuePointSeconds = ref(0)
const bottomDeckCuePointSeconds = ref(0)
const topDetailRef = ref<any | null>(null)
const bottomDetailRef = ref<any | null>(null)
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
const deckCuePreviewState = reactive<Record<DeckKey, DeckCuePreviewState>>({
  top: createDefaultDeckCuePreviewState(),
  bottom: createDefaultDeckCuePreviewState()
})
const deckWaveformDragState = reactive<Record<DeckKey, DeckWaveformDragState>>({
  top: createDefaultDeckWaveformDragState(),
  bottom: createDefaultDeckWaveformDragState()
})
const suppressDeckCueClick = reactive<Record<DeckKey, boolean>>({ top: false, bottom: false })

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
const resolveDeckCuePreviewRuntimeState = (deck: DeckKey) => deckCuePreviewState[deck]
const resolveDeckCurrentSeconds = (deck: DeckKey) =>
  Number(resolveTransportDeckSnapshot(deck).currentSec) || 0
const resolveDeckDurationSeconds = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckDurationSeconds(
    resolveTransportDeckSnapshot(deck).durationSec,
    resolveDeckSong(deck)?.duration
  )
const resolveDeckPlaying = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).playing)
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
const syncDeckDefaultCue = (deck: DeckKey, song: ISongInfo | null, force = false) => {
  const target = resolveDeckCuePointRef(deck)
  if (!force && target.value > 0.000001) return
  target.value = resolveHorizontalBrowseDefaultCuePointSec(song, resolveDeckDurationSeconds(deck))
}
const resolveDeckToolbarBpmInputValue = (deck: DeckKey) => {
  const toolbarState = deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value
  if (!resolveDeckSyncUiEnabled(deck)) {
    return toolbarState.bpmInputValue
  }
  return (Number(resolveTransportDeckSnapshot(deck).effectiveBpm) || 0).toFixed(2)
}
const resolveDeckToolbarState = (deck: DeckKey) =>
  buildHorizontalBrowseDeckToolbarState(
    deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value,
    resolveDeckToolbarBpmInputValue(deck)
  )
let renderSyncRaf = 0

const buildDeckStateForNative = (deck: DeckKey, override?: DeckTransportStateOverride) => ({
  song: resolveDeckSong(deck),
  currentSec: override?.currentSec ?? resolveDeckCurrentSeconds(deck),
  lastObservedAtMs: override?.lastObservedAtMs ?? performance.now(),
  durationSec: override?.durationSec ?? resolveDeckDurationSeconds(deck),
  playing: override?.playing ?? resolveDeckPlaying(deck),
  playbackRate: override?.playbackRate ?? resolveDeckPlaybackRate(deck)
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
      void commitDeckStateToNative(deck)
    }
  } catch {}
}

const assignSongToDeck = (deck: DeckKey, song: ISongInfo) => {
  const nextSong = { ...song }
  setDeckSong(deck, nextSong)
  syncDeckDefaultCue(deck, nextSong, true)
  const nowMs = performance.now()
  void commitDeckStateToNative(deck, {
    currentSec: 0,
    lastObservedAtMs: nowMs,
    durationSec: parseHorizontalBrowseDurationToSeconds(nextSong.duration),
    playing: false,
    playbackRate: 1
  })
  void hydrateDeckSongSharedGrid(deck, nextSong)
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

const handleToolbarStateChange = (
  deck: DeckKey,
  value: ReturnType<typeof createDefaultDeckToolbarState>
) => {
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
      void commitDeckStateToNative(deck)
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

const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
  const dragState = deckWaveformDragState[deck]
  if (dragState.active) return

  const snapshot = resolveTransportDeckSnapshot(deck)
  dragState.active = true
  dragState.wasPlaying = snapshot.playing
  dragState.syncEnabledBefore = snapshot.syncEnabled
  dragState.token += 1

  if (!dragState.wasPlaying) return

  const token = dragState.token
  void nativeTransport
    .setPlaying(deck, false)
    .then(() => {
      if (!deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== token) return
      syncDeckRenderState()
    })
    .catch(() => {})
}

const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
  const dragState = deckWaveformDragState[deck]
  const shouldResume = dragState.wasPlaying
  const syncEnabledBefore = dragState.syncEnabledBefore

  dragState.active = false
  dragState.wasPlaying = false
  dragState.syncEnabledBefore = false
  dragState.token += 1

  if (!payload?.committed) return

  const token = dragState.token
  const targetSec = Math.max(0, Number(payload.anchorSec) || 0)
  void (async () => {
    await nativeTransport.seek(deck, targetSec)
    if (deckWaveformDragState[deck].token !== token) return
    if (shouldResume) {
      if (syncEnabledBefore) {
        await nativeTransport.beatsync(deck)
        if (deckWaveformDragState[deck].token !== token) return
      }
      await nativeTransport.setPlaying(deck, true)
      if (deckWaveformDragState[deck].token !== token) return
    }
    syncDeckRenderState()
  })().catch(() => {})
}

const handleDeckPlayheadSeek = (deck: DeckKey, seconds: number) => {
  void nativeTransport.seek(deck, seconds).then(() => {
    syncDeckRenderState()
  })
}

const isDeckStoppedAtCuePoint = (deck: DeckKey) => {
  if (resolveDeckPlaying(deck) || !resolveDeckSong(deck)) return false
  const cueSeconds = resolveDeckCuePointRef(deck).value
  return Math.abs(resolveDeckCurrentSeconds(deck) - cueSeconds) <= CUE_POINT_TRIGGER_EPSILON_SEC
}

const handleDeckBackCue = async (
  deck: DeckKey,
  cueSeconds = resolveDeckCuePointRef(deck).value
) => {
  await nativeTransport.setPlaying(deck, false)
  await nativeTransport.seek(deck, cueSeconds)
  syncDeckRenderState()
}

const handleDeckSetCueFromCurrentPosition = async (deck: DeckKey) => {
  const cueRef = resolveDeckCuePointRef(deck)
  const song = resolveDeckSong(deck)
  const nextCuePoint = resolveHorizontalBrowseCuePointSec(
    song,
    resolveDeckCurrentSeconds(deck),
    resolveDeckDurationSeconds(deck)
  )
  cueRef.value = nextCuePoint
  await nativeTransport.seek(deck, nextCuePoint)
  syncDeckRenderState()
}

const startDeckCuePreview = (deck: DeckKey, pointerId: number) => {
  const cuePreviewState = resolveDeckCuePreviewRuntimeState(deck)
  if (cuePreviewState.active) return

  const snapshot = resolveTransportDeckSnapshot(deck)
  cuePreviewState.active = true
  cuePreviewState.pointerId = pointerId
  cuePreviewState.cueSeconds = resolveDeckCuePointRef(deck).value
  cuePreviewState.syncEnabledBefore = snapshot.syncEnabled
  cuePreviewState.syncLockBefore = snapshot.syncLock
  cuePreviewState.token += 1

  const token = cuePreviewState.token
  const syncEnabledBefore = cuePreviewState.syncEnabledBefore
  void (async () => {
    if (syncEnabledBefore) {
      await nativeTransport.setSyncEnabled(deck, false)
    }
    const latestState = resolveDeckCuePreviewRuntimeState(deck)
    if (!latestState.active || latestState.token !== token) return
    await nativeTransport.setPlaying(deck, true)
    if (resolveDeckCuePreviewRuntimeState(deck).token !== token) return
    syncDeckRenderState()
  })()
}

const stopDeckCuePreview = (deck: DeckKey, pointerId?: number) => {
  const cuePreviewState = resolveDeckCuePreviewRuntimeState(deck)
  if (!cuePreviewState.active) return
  if (typeof pointerId === 'number' && cuePreviewState.pointerId !== pointerId) return

  const cueSeconds = cuePreviewState.cueSeconds
  const syncEnabledBefore = cuePreviewState.syncEnabledBefore
  cuePreviewState.active = false
  cuePreviewState.pointerId = null
  cuePreviewState.cueSeconds = 0
  cuePreviewState.syncEnabledBefore = false
  cuePreviewState.syncLockBefore = 'off'
  cuePreviewState.token += 1

  void (async () => {
    await nativeTransport.setPlaying(deck, false).catch(() => {})
    await nativeTransport.seek(deck, cueSeconds).catch(() => {})
    if (syncEnabledBefore) {
      await nativeTransport.setSyncEnabled(deck, true).catch(() => {})
    }
    syncDeckRenderState()
  })()
}

const stopAllDeckCuePreview = () => {
  stopDeckCuePreview('top')
  stopDeckCuePreview('bottom')
  suppressDeckCueClick.top = suppressDeckCueClick.bottom = false
}

const clearDeckCueClickSuppressSoon = () =>
  requestAnimationFrame(() => {
    suppressDeckCueClick.top = false
    suppressDeckCueClick.bottom = false
  })

const handleWindowDeckCuePointerUp = (event: PointerEvent) => {
  stopDeckCuePreview('top', event.pointerId)
  stopDeckCuePreview('bottom', event.pointerId)
  clearDeckCueClickSuppressSoon()
}

const handleDeckCuePointerDown = (deck: DeckKey, event: PointerEvent) => {
  if (event.button !== 0) return
  suppressDeckCueClick[deck] = true
  event.preventDefault()

  if (resolveDeckPlaying(deck)) {
    void handleDeckBackCue(deck)
    return
  }
  if (isDeckStoppedAtCuePoint(deck)) {
    startDeckCuePreview(deck, event.pointerId)
    return
  }
  void handleDeckSetCueFromCurrentPosition(deck)
}

const handleDeckCueClick = (deck: DeckKey) => {
  if (suppressDeckCueClick[deck]) {
    suppressDeckCueClick[deck] = false
    return
  }
  if (resolveDeckPlaying(deck)) {
    void handleDeckBackCue(deck)
    return
  }
  if (isDeckStoppedAtCuePoint(deck)) return
  void handleDeckSetCueFromCurrentPosition(deck)
}

const handleDeckPlayPauseToggle = (deck: DeckKey) => {
  const nextPlaying = deck === 'top' ? !topDeckUiPlaying.value : !bottomDeckUiPlaying.value
  void (async () => {
    if (nextPlaying && resolveTransportDeckSnapshot(deck).syncEnabled) {
      await commitDeckStatesToNative()
      await nativeTransport.beatsync(deck)
    }
    await nativeTransport.setPlaying(deck, nextPlaying)
    syncDeckRenderState()
  })()
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
  await nativeTransport.setSyncEnabled(deck, true)
  if (resolveDeckPlaying(deck)) {
    await nativeTransport.beatsync(deck)
  }
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
  window.addEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.addEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.addEventListener('blur', stopAllDeckCuePreview)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
})

onUnmounted(() => {
  stopAllDeckCuePreview()
  stopRenderSyncLoop()
  stopFaderDragging()
  window.removeEventListener('drop', handleGlobalDragFinish, true)
  window.removeEventListener('dragend', handleGlobalDragFinish, true)
  window.removeEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.removeEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.removeEventListener('blur', stopAllDeckCuePreview)
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
  runtime.horizontalBrowseDecks.topSong = null
  runtime.horizontalBrowseDecks.bottomSong = null
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
        :current-seconds="topDeckRenderCurrentSeconds"
        :duration-seconds="topDeckDurationSeconds"
        :toolbar-state="resolveDeckToolbarState('top')"
        :read-only-source="isDeckSongReadOnly('top')"
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
        @tap-bpm="handleDeckTapBpm('top')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('top')"
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
          :cue-seconds="topDeckCuePointSeconds"
          :defer-waveform-load="topDeckShouldDeferWaveformLoad"
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
          :cue-seconds="bottomDeckCuePointSeconds"
          :defer-waveform-load="bottomDeckShouldDeferWaveformLoad"
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
        :current-seconds="bottomDeckRenderCurrentSeconds"
        :duration-seconds="bottomDeckDurationSeconds"
        :toolbar-state="resolveDeckToolbarState('bottom')"
        :read-only-source="isDeckSongReadOnly('bottom')"
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
        @tap-bpm="handleDeckTapBpm('bottom')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('bottom')"
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
