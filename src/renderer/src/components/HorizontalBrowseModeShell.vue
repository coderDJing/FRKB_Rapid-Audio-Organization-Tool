<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckButtons from '@renderer/components/HorizontalBrowseDeckButtons.vue'
import HorizontalBrowseDeckDetailLane from '@renderer/components/HorizontalBrowseDeckDetailLane.vue'
import HorizontalBrowseDeckMoveDialog from '@renderer/components/HorizontalBrowseDeckMoveDialog.vue'
import HorizontalBrowseDeckOverviewSection from '@renderer/components/HorizontalBrowseDeckOverviewSection.vue'
import HorizontalBrowseCuePanels from '@renderer/components/HorizontalBrowseCuePanels.vue'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
} from '@renderer/components/horizontalBrowseWaveform.constants'
import {
  buildHorizontalBrowseDeckToolbarState,
  resolveHorizontalBrowseDeckDurationSeconds,
  resolveHorizontalBrowseDeckGridBpm,
  resolveHorizontalBrowseDeckSyncUiEnabled,
  resolveHorizontalBrowseDeckSyncUiLock
} from '@renderer/components/horizontalBrowseShellState'
import { buildHorizontalBrowseSongSnapshot } from '@renderer/components/horizontalBrowseShellSongs'
import { formatPreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
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
import { useHorizontalBrowseDeckHotCues } from '@renderer/components/useHorizontalBrowseDeckHotCues'
import { useHorizontalBrowseDeckMemoryCues } from '@renderer/components/useHorizontalBrowseDeckMemoryCues'
import { useHorizontalBrowseDeckQuantize } from '@renderer/components/useHorizontalBrowseDeckQuantize'
import { useHorizontalBrowseDeckSongSync } from '@renderer/components/useHorizontalBrowseDeckSongSync'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'
import emitter from '@renderer/utils/mitt'
import { createHorizontalBrowseDeckAssigner } from '@renderer/components/horizontalBrowseDeckAssignment'
import { useHorizontalBrowseOutput } from '@renderer/components/useHorizontalBrowseOutput'
import { useHorizontalBrowseTransportController } from '@renderer/components/useHorizontalBrowseTransportController'
import { useHorizontalBrowseTransportMutations } from '@renderer/components/useHorizontalBrowseTransportMutations'

type DeckKey = HorizontalBrowseDeckKey

type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}
type DeckCuePanelMode = 'memory' | 'hot-cue'
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
const topDeckToolbarState = ref(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref(createDefaultDeckToolbarState())
const hoveredDeckKey = ref<DeckKey | null>(null)
const sharedDetailZoomState = ref<SharedDetailZoomState>({
  value: HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  anchorRatio: 0.5,
  sourceDirection: null,
  revision: 0
})
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

const topOverviewRegions = [1, 2, 3]
const bottomOverviewRegions = [6, 7, 8]
const deckCuePanelMode = reactive<Record<DeckKey, DeckCuePanelMode>>({
  top: 'memory',
  bottom: 'memory'
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

const {
  nativeTransport,
  deckSyncState,
  deckSeekIntent,
  topDeckPlaybackRate,
  bottomDeckPlaybackRate,
  topDeckRenderCurrentSeconds,
  bottomDeckRenderCurrentSeconds,
  resolveTransportDeckSnapshot,
  resolveDeckCurrentSeconds,
  resolveDeckPlaying,
  resolveDeckLoaded,
  resolveDeckDecoding,
  resolveDeckPlaybackRate,
  resolveDeckRenderCurrentSeconds,
  syncDeckRenderState,
  startSnapshotSync,
  stopSnapshotSync,
  startRenderSyncLoop,
  stopRenderSyncLoop,
  notifyDeckSeekIntent
} = useHorizontalBrowseTransportController()
const {
  faderRef,
  faderRailRef,
  faderTicks,
  faderThumbStyle,
  faderDragging,
  syncCrossfaderValue,
  handleFaderPointerDown,
  handleFaderDoubleClick,
  nudgeCrossfaderByKeyboard,
  resetCrossfaderByKeyboard
} = useHorizontalBrowseOutput({
  nativeTransport
})
const topDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('top'))
const bottomDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('bottom'))
const resolveDeckCuePointRef = (deck: DeckKey) =>
  deck === 'top' ? topDeckCuePointSeconds : bottomDeckCuePointSeconds
const resolveDeckDurationSeconds = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckDurationSeconds(
    resolveTransportDeckSnapshot(deck).durationSec,
    resolveDeckSong(deck)?.duration
  )
const topDeckUiPlaying = computed(() => resolveDeckPlaying('top'))
const bottomDeckUiPlaying = computed(() => resolveDeckPlaying('bottom'))
const topDeckCueActive = computed(
  () => resolveDeckCuePreviewRuntimeState('top').active || deckPendingCuePreviewOnLoad.top
)
const bottomDeckCueActive = computed(
  () => resolveDeckCuePreviewRuntimeState('bottom').active || deckPendingCuePreviewOnLoad.bottom
)
const topDeckPlayButtonActive = computed(() => topDeckUiPlaying.value && !topDeckCueActive.value)
const bottomDeckPlayButtonActive = computed(
  () => bottomDeckUiPlaying.value && !bottomDeckCueActive.value
)
const topDeckUiDecoding = computed(() => resolveDeckDecoding('top'))
const bottomDeckUiDecoding = computed(() => resolveDeckDecoding('bottom'))
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
const {
  deckQuantizeEnabled,
  toggleDeckQuantize,
  resolveDeckCuePlacementSec,
  resolveDeckMarkerPlacementSec
} = useHorizontalBrowseDeckQuantize({
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckDurationSeconds,
  resolveDeckSong,
  resolveCuePointSec: resolveHorizontalBrowseCuePointSec
})
const resolveDeckMarkerPlacementSeconds = (deck: DeckKey) =>
  Math.max(0, Number(resolveDeckMarkerPlacementSec(deck)) || 0)
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

let resolveDeckMasterTempoEnabledForTransport: (deck: DeckKey) => boolean = () => true

const { commitDeckStateToNative, commitDeckStatesToNative, toggleDeckMaster, triggerDeckBeatSync } =
  useHorizontalBrowseTransportMutations({
    touchDeckInteraction,
    nativeTransport,
    syncDeckRenderState,
    resolveDeckSong,
    resolveDeckCurrentSeconds,
    resolveDeckDurationSeconds,
    resolveDeckPlaying,
    resolveDeckPlaybackRate,
    resolveDeckMasterTempoEnabled: (deck) => resolveDeckMasterTempoEnabledForTransport(deck),
    resolveTransportDeckSnapshot
  })

const {
  selectSongListDialogVisible,
  selectSongListDialogTargetLibraryName,
  selectSongListDialogActionMode,
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

resolveDeckMasterTempoEnabledForTransport = isDeckMasterTempoEnabled

const handleDeckMasterTempoToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckMasterTempo(deck)
  void commitDeckStateToNative(deck, {
    masterTempoEnabled: isDeckMasterTempoEnabled(deck)
  })
}

const { assignSongToDeck } = createHorizontalBrowseDeckAssigner({
  touchDeckInteraction,
  setDeckSong,
  resolveDeckSong,
  shouldDeferDeckSongPriorityAnalysis: (deck) => {
    const otherDeck = deck === 'top' ? 'bottom' : 'top'
    return resolveDeckPlaying(otherDeck) && !resolveDeckPlaying(deck)
  },
  syncDeckDefaultCue,
  setDeckBeatGridToNative: nativeTransport.setBeatGrid,
  commitDeckStateToNative
})

const {
  deckPendingPlayOnLoad,
  deckPendingCuePreviewOnLoad,
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
  handleDeckPhraseJump,
  handleDeckSeekPercent,
  buildDeckStoredCueDefinition,
  handleDeckMemoryCueRecall,
  handleDeckHotCueRecall,
  stopAllDeckCuePreview,
  handleWindowDeckCuePointerUp,
  handleDeckCuePointerDown,
  handleDeckCueClick,
  handleDeckCueHotkeyDown,
  handleDeckCueHotkeyUp,
  handleDeckPlayPauseToggle
} = useHorizontalBrowseDeckTransportInteractions({
  touchDeckInteraction,
  notifyDeckSeekIntent,
  nativeTransport,
  syncDeckRenderState,
  commitDeckStatesToNative,
  resolveDeckSong,
  resolveDeckGridBpm,
  resolveDeckDurationSeconds,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckPlaying,
  resolveDeckLoaded,
  resolveTransportDeckSnapshot,
  resolveDeckCuePointRef,
  resolveDeckCuePlacementSec
})

const { handleDeckHotCuePress, handleDeckHotCueDelete, handleSongHotCuesUpdated } =
  useHorizontalBrowseDeckHotCues({
    resolveDeckSong,
    setDeckSong,
    resolveDeckMarkerPlacementSec: resolveDeckMarkerPlacementSeconds,
    resolveDeckPlaying,
    resolveDeckDurationSeconds,
    resolveTransportDeckSnapshot,
    buildDeckStoredCueDefinition,
    handleDeckHotCueRecall,
    nativeTransport,
    commitDeckStatesToNative,
    syncDeckRenderState,
    isDeckLoopActive
  })

const {
  handleDeckMemoryCueCreate,
  handleDeckMemoryCueDelete,
  handleDeckMemoryCueRecallPress,
  handleSongMemoryCuesUpdated
} = useHorizontalBrowseDeckMemoryCues({
  resolveDeckSong,
  setDeckSong,
  buildDeckStoredCueDefinition,
  handleDeckMemoryCueRecall
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

const handleDeckQuantizeToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckQuantize(deck)
}

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
  const playingBoost = resolveDeckPlaying(deck) ? 4_000_000 : 0
  const dragBoost = isDeckWaveformDragging(deck) ? 3_000_000 : 0
  const cuePreviewBoost = resolveDeckCuePreviewRuntimeState(deck).active ? 2_500_000 : 0
  const recentBoost = !resolveDeckPlaying(deck) && deckRecentInteraction[deck] ? 1_000_000 : 0
  const loadedBoost = resolveDeckSong(deck) ? 100_000 : 0
  return (
    playingBoost +
    dragBoost +
    cuePreviewBoost +
    recentBoost +
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

const handleCrossfaderNudgeByKeyboard = (direction: -1 | 1) => {
  nudgeCrossfaderByKeyboard(direction)
}

const handleCrossfaderResetByKeyboard = () => {
  resetCrossfaderByKeyboard()
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
  onJumpPhrase: handleDeckPhraseJump,
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

const { disposeSongSync, handleExternalDeckSongLoad, handleSongGridUpdated, handleSongKeyUpdated } =
  useHorizontalBrowseDeckSongSync({
    topDeckSong,
    bottomDeckSong,
    resolveDeckSong,
    setDeckSong,
    syncDeckDefaultCue,
    setDeckBeatGridToNative: (deck, payload) => nativeTransport.setBeatGrid(deck, payload),
    assignSongToDeck
  })

watch(
  () => deckSyncState.leaderDeck,
  (leaderDeck) => {
    runtime.horizontalBrowseDecks.leaderDeck =
      leaderDeck === 'top' || leaderDeck === 'bottom' ? leaderDeck : null
  },
  { immediate: true }
)

onMounted(() => {
  startSnapshotSync()
  void nativeTransport.reset().finally(() => {
    syncCrossfaderValue(0)
  })
  startRenderSyncLoop(handleDeckLoopPlaybackTick)
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  window.addEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.addEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.addEventListener('blur', stopAllDeckCuePreview)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.on('song-key-updated', handleSongKeyUpdated)
  window.electron.ipcRenderer.on('song-hot-cues-updated', handleSongHotCuesUpdated)
  window.electron.ipcRenderer.on('song-memory-cues-updated', handleSongMemoryCuesUpdated)
})

onUnmounted(() => {
  stopAllDeckCuePreview()
  stopSnapshotSync()
  void nativeTransport.reset().catch((error) => {
    console.error('[horizontal-browse] reset transport failed on exit', error)
  })
  stopRenderSyncLoop()
  clearDeckRecentInteractionTimer('top')
  clearDeckRecentInteractionTimer('bottom')
  window.removeEventListener('drop', handleGlobalDragFinish, true)
  window.removeEventListener('dragend', handleGlobalDragFinish, true)
  window.removeEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.removeEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.removeEventListener('blur', stopAllDeckCuePreview)
  disposeSongSync()
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.removeListener('song-key-updated', handleSongKeyUpdated)
  window.electron.ipcRenderer.removeListener('song-hot-cues-updated', handleSongHotCuesUpdated)
  window.electron.ipcRenderer.removeListener(
    'song-memory-cues-updated',
    handleSongMemoryCuesUpdated
  )
  runtime.horizontalBrowseDecks.topSong = null
  runtime.horizontalBrowseDecks.bottomSong = null
  runtime.horizontalBrowseDecks.leaderDeck = null
})
</script>

<template>
  <div class="horizontal-shell">
    <div class="controls">
      <HorizontalBrowseDeckButtons
        :playing="topDeckPlayButtonActive"
        :decoding="topDeckUiDecoding"
        :pending-play="deckPendingPlayOnLoad.top"
        :pending-cue="deckPendingCuePreviewOnLoad.top"
        :cue-active="topDeckCueActive"
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
        :playing="bottomDeckPlayButtonActive"
        :decoding="bottomDeckUiDecoding"
        :pending-play="deckPendingPlayOnLoad.bottom"
        :pending-cue="deckPendingCuePreviewOnLoad.bottom"
        :cue-active="bottomDeckCueActive"
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
        :hot-cues="topDeckSong?.hotCues || []"
        :memory-cues="topDeckSong?.memoryCues || []"
        :toolbar-state="resolveDeckToolbarState('top')"
        :loop-range="resolveDeckLoopRange('top')"
        :read-only-source="isDeckSongReadOnly('top')"
        :quantize-enabled="deckQuantizeEnabled.top"
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
        @memory-cue="void handleDeckMemoryCueCreate('top')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('top')"
        @toggle-metronome="handleDeckMetronomeToggle('top')"
        @cycle-metronome-volume="handleDeckMetronomeVolumeCycle('top')"
        @loop-step-down="handleDeckLoopStepDown('top')"
        @loop-step-up="handleDeckLoopStepUp('top')"
        @toggle-loop="handleDeckLoopToggle('top')"
        @toggle-master-tempo="handleDeckMasterTempoToggle('top')"
        @reset-tempo="resetDeckTempo('top')"
        @toggle-quantize="handleDeckQuantizeToggle('top')"
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
          :loop-range="resolveDeckLoopRange('top')"
          :cue-seconds="topDeckCuePointSeconds"
          :hot-cues="topDeckSong?.hotCues || []"
          :memory-cues="topDeckSong?.memoryCues || []"
          :defer-waveform-load="topDeckShouldDeferWaveformLoad"
          :raw-load-priority-hint="topDeckRawLoadPriorityHint"
          :seek-target-seconds="deckSeekIntent.top.seconds"
          :seek-revision="deckSeekIntent.top.revision"
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
          :loop-range="resolveDeckLoopRange('bottom')"
          :cue-seconds="bottomDeckCuePointSeconds"
          :hot-cues="bottomDeckSong?.hotCues || []"
          :memory-cues="bottomDeckSong?.memoryCues || []"
          :defer-waveform-load="bottomDeckShouldDeferWaveformLoad"
          :raw-load-priority-hint="bottomDeckRawLoadPriorityHint"
          :seek-target-seconds="deckSeekIntent.bottom.seconds"
          :seek-revision="deckSeekIntent.bottom.revision"
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
        :hot-cues="bottomDeckSong?.hotCues || []"
        :memory-cues="bottomDeckSong?.memoryCues || []"
        :toolbar-state="resolveDeckToolbarState('bottom')"
        :loop-range="resolveDeckLoopRange('bottom')"
        :read-only-source="isDeckSongReadOnly('bottom')"
        :quantize-enabled="deckQuantizeEnabled.bottom"
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
        @memory-cue="void handleDeckMemoryCueCreate('bottom')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('bottom')"
        @toggle-metronome="handleDeckMetronomeToggle('bottom')"
        @cycle-metronome-volume="handleDeckMetronomeVolumeCycle('bottom')"
        @loop-step-down="handleDeckLoopStepDown('bottom')"
        @loop-step-up="handleDeckLoopStepUp('bottom')"
        @toggle-loop="handleDeckLoopToggle('bottom')"
        @toggle-master-tempo="handleDeckMasterTempoToggle('bottom')"
        @reset-tempo="resetDeckTempo('bottom')"
        @toggle-quantize="handleDeckQuantizeToggle('bottom')"
        @select-move-target="openDeckMoveDialog('bottom', $event)"
      />
      <HorizontalBrowseCuePanels
        v-model:top-mode="deckCuePanelMode.top"
        v-model:bottom-mode="deckCuePanelMode.bottom"
        :top-hot-cues="topDeckSong?.hotCues || []"
        :bottom-hot-cues="bottomDeckSong?.hotCues || []"
        :top-memory-cues="topDeckSong?.memoryCues || []"
        :bottom-memory-cues="bottomDeckSong?.memoryCues || []"
        @hotcue-press="void handleDeckHotCuePress($event.deck, $event.slot)"
        @hotcue-delete="void handleDeckHotCueDelete($event.deck, $event.slot)"
        @memorycue-press="void handleDeckMemoryCueRecallPress($event.deck, $event.sec)"
        @memorycue-delete="void handleDeckMemoryCueDelete($event.deck, $event.sec)"
      />
    </div>

    <HorizontalBrowseDeckMoveDialog
      :visible="selectSongListDialogVisible"
      :library-name="selectSongListDialogTargetLibraryName"
      :action-mode="selectSongListDialogActionMode"
      @confirm="handleDeckMoveSong"
      @cancel="handleDeckMoveDialogCancel"
    />
  </div>
</template>

<style scoped lang="scss" src="./HorizontalBrowseModeShell.scss"></style>
