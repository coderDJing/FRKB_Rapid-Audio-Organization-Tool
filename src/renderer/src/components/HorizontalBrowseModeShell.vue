<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckControlRow from '@renderer/components/HorizontalBrowseDeckControlRow.vue'
import HorizontalBrowseDeckDetailLane from '@renderer/components/HorizontalBrowseDeckDetailLane.vue'
import HorizontalBrowseEditDeckControls from '@renderer/components/HorizontalBrowseEditDeckControls.vue'
import HorizontalBrowseDeckMoveDialog from '@renderer/components/HorizontalBrowseDeckMoveDialog.vue'
import HorizontalBrowseDeckOverviewSection from '@renderer/components/HorizontalBrowseDeckOverviewSection.vue'
import HorizontalBrowseCuePanels from '@renderer/components/HorizontalBrowseCuePanels.vue'
import HorizontalBrowseFaderPanel from '@renderer/components/HorizontalBrowseFaderPanel.vue'
import {
  HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
} from '@renderer/components/horizontalBrowseWaveform.constants'
import {
  buildHorizontalBrowseDeckToolbarState,
  resolveHorizontalBrowseDeckDurationSeconds,
  resolveHorizontalBrowseDeckGridBpm,
  resolveHorizontalBrowseDeckSyncUiEnabled,
  resolveHorizontalBrowseDeckSyncUiLock,
  resolveHorizontalBrowseDeckWaveformGain
} from '@renderer/components/horizontalBrowseShellState'
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
import { useHorizontalBrowseDeckTempoNudge } from '@renderer/components/useHorizontalBrowseDeckTempoNudge'
import { useHorizontalBrowseDeckToolbarInteractions } from '@renderer/components/useHorizontalBrowseDeckToolbarInteractions'
import { useHorizontalBrowseDeckTransportInteractions } from '@renderer/components/useHorizontalBrowseDeckTransportInteractions'
import { useHorizontalBrowseEditDeckNavigation } from '@renderer/components/useHorizontalBrowseEditDeckNavigation'
import { useHorizontalBrowseDeckHotCues } from '@renderer/components/useHorizontalBrowseDeckHotCues'
import { useHorizontalBrowseDeckMemoryCues } from '@renderer/components/useHorizontalBrowseDeckMemoryCues'
import { useHorizontalBrowseDeckQuantize } from '@renderer/components/useHorizontalBrowseDeckQuantize'
import { useHorizontalBrowseDeckSongSync } from '@renderer/components/useHorizontalBrowseDeckSongSync'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'
import emitter from '@renderer/utils/mitt'
import { createHorizontalBrowseDeckAssigner } from '@renderer/components/horizontalBrowseDeckAssignment'
import type { HorizontalBrowseDeckAssignTransportOptions } from '@renderer/components/horizontalBrowseDeckAssignment'
import { useHorizontalBrowseTransportController } from '@renderer/components/useHorizontalBrowseTransportController'
import { useHorizontalBrowseTransportMutations } from '@renderer/components/useHorizontalBrowseTransportMutations'
import { useHorizontalBrowseFaderControls } from '@renderer/components/useHorizontalBrowseFaderControls'
import { useHorizontalBrowseVisualizer } from '@renderer/components/useHorizontalBrowseVisualizer'
import {
  useHorizontalBrowseDeckSourceState,
  type HorizontalBrowseDeckSongSourceOptions
} from '@renderer/components/useHorizontalBrowseDeckSourceState'
import { useHorizontalBrowseDeckDrop } from '@renderer/components/useHorizontalBrowseDeckDrop'
import { useHorizontalBrowseDeckInteractionState } from '@renderer/components/useHorizontalBrowseDeckInteractionState'
import { useHorizontalBrowseSongsRemoved } from '@renderer/components/useHorizontalBrowseSongsRemoved'
import {
  createDefaultDeckToolbarState,
  createDefaultSharedDetailZoomState,
  DUAL_MODE_BPM_INPUT_TITLE,
  EDIT_MODE_BPM_INPUT_TITLE,
  EDIT_MODE_TAP_BPM_TITLE,
  type DeckCuePanelMode,
  type HorizontalBrowseDeckDetailLaneExpose,
  type HorizontalBrowseViewMode,
  type SharedDetailZoomState
} from '@renderer/components/horizontalBrowseModeShellTypes'
import { useHorizontalBrowseModePlaybackHandoff } from '@renderer/components/useHorizontalBrowseModePlaybackHandoff'
import { useHorizontalBrowseVolumeSync } from '@renderer/components/useHorizontalBrowseVolumeSync'
import { MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT } from '@renderer/utils/mainWindowPlaybackHandoff'
import { useHorizontalBrowseWaveformPresentationCoordinator } from '@renderer/components/horizontalBrowseWaveformPresentationCoordinator'
import { createHorizontalBrowseWaveformPresentationShellBridge } from '@renderer/components/horizontalBrowseWaveformPresentationShellBridge'
import type { HorizontalBrowseDetailZoomChangePayload } from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'
import { createHorizontalBrowseModeShellDetailTransactions } from '@renderer/components/horizontalBrowseModeShellDetailTransactions'
import {
  resolveHorizontalBrowseDeckToolbarBpmInputValue,
  resolveHorizontalBrowseDeckWaveformPlaybackActive
} from '@renderer/components/horizontalBrowseModeShellPresentationResolvers'

type DeckKey = HorizontalBrowseDeckKey
const props = withDefaults(defineProps<{ viewMode?: HorizontalBrowseViewMode }>(), {
  viewMode: 'dual'
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
const waveformPresentation = useHorizontalBrowseWaveformPresentationCoordinator()
const topDetailRef = ref<HorizontalBrowseDeckDetailLaneExpose | null>(null)
const bottomDetailRef = ref<HorizontalBrowseDeckDetailLaneExpose | null>(null)
const resolveDetailRef = (deck: DeckKey) =>
  deck === 'top' ? topDetailRef.value : bottomDetailRef.value
const { prepareDeckStableFrameForAnchor, commitLinkedGridVisualTransaction } =
  createHorizontalBrowseModeShellDetailTransactions({
    presentation: waveformPresentation,
    resolveDetailRef
  })
const faderPanelRef = ref<InstanceType<typeof HorizontalBrowseFaderPanel> | null>(null)
const topDeckToolbarState = ref(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref(createDefaultDeckToolbarState())
const sharedDetailZoomState = ref<SharedDetailZoomState>(
  createDefaultSharedDetailZoomState(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
)
const editDetailZoomState = ref<SharedDetailZoomState>(
  createDefaultSharedDetailZoomState(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
)
const horizontalBrowseViewMode = computed<HorizontalBrowseViewMode>(() => props.viewMode)
const isEditMode = computed(() => horizontalBrowseViewMode.value === 'edit')
const isLightTheme = computed(() => {
  const mode = runtime.setting?.themeMode || 'system'
  if (mode === 'light') return true
  if (mode === 'dark') return false
  if (typeof document === 'undefined') return false
  return (
    document.documentElement.classList.contains('theme-light') ||
    document.body.classList.contains('theme-light')
  )
})
watch(
  isEditMode,
  (editMode) => {
    waveformPresentation.setSurfaceMode('top', editMode ? 'edit-detail' : 'dual-detail')
    waveformPresentation.setSurfaceMode('bottom', 'dual-detail')
  },
  { immediate: true }
)
const {
  resolveSongsAreaStateBySongListUUID,
  resolveSongListSnapshot,
  resolveDeckSongSourceOptions,
  setDeckSongListSource,
  clearDeckSongListSource,
  clearAllDeckSongListSources
} = useHorizontalBrowseDeckSourceState()
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
  if (!song) {
    clearDeckSongListSource(deck)
  }
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
const { touchDeckInteraction, clearDeckRecentInteractionTimer } =
  useHorizontalBrowseDeckInteractionState()
const {
  nativeTransport,
  deckSyncState,
  deckSeekIntent,
  topDeckPlaybackRate,
  bottomDeckPlaybackRate,
  topDeckRenderCurrentSeconds,
  bottomDeckRenderCurrentSeconds,
  topDeckPlaybackSyncRevision,
  bottomDeckPlaybackSyncRevision,
  resolveTransportDeckSnapshot,
  resolveDeckCurrentSeconds,
  resolveDeckPlaying,
  resolveDeckLoaded,
  resolveDeckDecoding,
  resolveDeckRenderCurrentSeconds,
  syncDeckRenderState,
  startSnapshotSync,
  stopSnapshotSync,
  startRenderSyncLoop,
  stopRenderSyncLoop,
  holdDeckRenderCurrentSeconds,
  startDeckRenderPlaybackClock,
  primeDeckRenderCurrentSeconds,
  notifyDeckSeekIntent
} = useHorizontalBrowseTransportController()
const notifyDeckSeekPresentationIntent = (deck: DeckKey, seconds: number) => {
  waveformPresentation.markSeek(deck, seconds)
  notifyDeckSeekIntent(deck, seconds)
}
useHorizontalBrowseVisualizer({ nativeTransport })
const { mainWindowVolume, syncCurrentVolume } = useHorizontalBrowseVolumeSync({ nativeTransport })
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
const HORIZONTAL_BROWSE_NEGATIVE_PLAYBACK_EPSILON_SEC = 0.0001
const resolveDeckWaveformPlaybackActive = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckWaveformPlaybackActive({
    deck,
    snapshot: resolveTransportDeckSnapshot(deck),
    topRenderCurrentSeconds: topDeckRenderCurrentSeconds,
    bottomRenderCurrentSeconds: bottomDeckRenderCurrentSeconds,
    negativePlaybackEpsilonSec: HORIZONTAL_BROWSE_NEGATIVE_PLAYBACK_EPSILON_SEC
  })
const topDeckWaveformPlaybackActive = computed(() => resolveDeckWaveformPlaybackActive('top'))
const bottomDeckWaveformPlaybackActive = computed(() => resolveDeckWaveformPlaybackActive('bottom'))
const resolveDeckWaveformGain = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckWaveformGain(resolveTransportDeckSnapshot(deck))
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
  resolveDeckGridBpm,
  resolveDeckSong,
  resolveCuePointSec: resolveHorizontalBrowseCuePointSec
})
const resolveDeckMarkerPlacementSeconds = (deck: DeckKey) =>
  Math.max(0, Number(resolveDeckMarkerPlacementSec(deck)) || 0)
const resolveDeckToolbarBpmInputValue = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckToolbarBpmInputValue({
    deck,
    toolbarState: deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value,
    deckTempoInputDirty,
    editMode: isEditMode.value,
    resolveDeckSong,
    resolveDeckGridBpm,
    resolveTransportDeckSnapshot
  })
let resolveDeckMasterTempoEnabledForTransport: (deck: DeckKey) => boolean = () => true
const {
  resolveDeckPlaybackRateForTransport,
  resolveDeckTempoNudgeDirection,
  startDeckTempoNudge,
  stopDeckTempoNudge,
  stopAllDeckTempoNudge,
  resetAllDeckTempoNudgePlaybackRates
} = useHorizontalBrowseDeckTempoNudge({
  touchDeckInteraction,
  nativeTransport,
  syncDeckRenderState,
  resolveDeckSong,
  resolveTransportDeckSnapshot
})

const { commitDeckStateToNative, commitDeckStatesToNative, toggleDeckMaster, triggerDeckBeatSync } =
  useHorizontalBrowseTransportMutations({
    touchDeckInteraction,
    nativeTransport,
    syncDeckRenderState,
    commitLinkedGridVisualTransaction,
    clearLinkedPresentation: waveformPresentation.clearLinkedPresentation,
    resolveDeckSong,
    resolveDeckCurrentSeconds,
    resolveDeckDurationSeconds,
    resolveDeckPlaying,
    resolveDeckPlaybackRate: resolveDeckPlaybackRateForTransport,
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
    nativeTransport
  })
resolveDeckMasterTempoEnabledForTransport = isDeckMasterTempoEnabled
const handleDeckMasterTempoToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckMasterTempo(deck)
  void nativeTransport.setMasterTempoEnabled(deck, isDeckMasterTempoEnabled(deck))
}

const {
  deckBandState,
  deckCueMonitorState,
  faderControlsExpanded,
  dualTransportSyncEnabled,
  dualTransportSyncActivating,
  canUseDualTransportSync,
  activateDualTransportSync,
  deactivateDualTransportSync,
  handleDualTransportSyncToggle,
  handleDeckBandToggle,
  handleDeckCueMonitorToggle,
  clearAllDeckCueMonitor
} = useHorizontalBrowseFaderControls({
  topDeckSong,
  bottomDeckSong,
  setting: runtime.setting,
  deckSyncState,
  nativeTransport,
  commitDeckStatesToNative,
  syncDeckRenderState,
  commitLinkedGridVisualTransaction,
  clearLinkedPresentation: waveformPresentation.clearLinkedPresentation,
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckDurationSeconds,
  resolveTransportDeckSnapshot
})
const { assignSongToDeck: assignSongToDeckBase } = createHorizontalBrowseDeckAssigner({
  touchDeckInteraction,
  setDeckSong,
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  shouldDeferDeckSongPriorityAnalysis: (deck) => {
    const otherDeck = deck === 'top' ? 'bottom' : 'top'
    return resolveDeckPlaying(otherDeck) && !resolveDeckPlaying(deck)
  },
  syncDeckDefaultCue,
  primeDeckRenderCurrentSeconds,
  setDeckBeatGridToNative: nativeTransport.setBeatGrid,
  commitDeckStateToNative
})

const assignSongToDeck = async (
  deck: DeckKey,
  song: ISongInfo,
  sourceOptions?: HorizontalBrowseDeckSongSourceOptions,
  transportOptions?: HorizontalBrowseDeckAssignTransportOptions
) => {
  setDeckSongListSource(deck, resolveDeckSongSourceOptions(sourceOptions))
  await assignSongToDeckBase(deck, song, transportOptions)
}

const {
  deckPendingPlayVisible,
  deckPendingCuePreviewOnLoad,
  suppressDeckCueClick,
  isDeckWaveformDragging,
  resolveDeckWaveformDragAnchorSec,
  resolveDeckCuePreviewRuntimeState,
  resolveDeckLoopRange,
  resolveDeckLoopBeatLabel,
  resolveDeckLoopDisabled,
  isDeckLoopActive,
  handleDeckLoopToggle,
  handleDeckLoopStepDown,
  handleDeckLoopStepUp,
  handleDeckLoopPlaybackTick,
  handleDeckRawWaveformDragStart: startDeckRawWaveformDrag,
  handleDeckRawWaveformScrubPreview: previewDeckRawWaveformScrub,
  handleDeckRawWaveformDragEnd: endDeckRawWaveformDrag,
  handleDeckPlayheadSeek,
  handleDeckBarJump,
  handleDeckPhraseJump,
  handleDeckBeatJump,
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
  notifyDeckSeekIntent: notifyDeckSeekPresentationIntent,
  holdDeckRenderCurrentSeconds,
  startDeckRenderPlaybackClock,
  prepareDeckStableFrameForAnchor,
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
  resolveDeckCuePlacementSec,
  resolveBrowseViewMode: () => horizontalBrowseViewMode.value,
  resolveDualTransportSyncEnabled: () =>
    dualTransportSyncEnabled.value && canUseDualTransportSync.value,
  ensureDualTransportSync: activateDualTransportSync,
  deactivateDualTransportSync
})
const {
  handleDeckRawWaveformDragStart,
  handleDeckRawWaveformScrubPreview,
  handleDeckRawWaveformDragEnd,
  markDetailZoomPresentation
} = createHorizontalBrowseWaveformPresentationShellBridge({
  presentation: waveformPresentation,
  resolveLinkedDragActive: () =>
    !isEditMode.value && dualTransportSyncEnabled.value && canUseDualTransportSync.value,
  resolveZoomLinked: () => horizontalBrowseViewMode.value !== 'edit',
  resolveDeckRenderCurrentSeconds,
  resolveDeckWaveformDragAnchorSec,
  startDeckRawWaveformDrag,
  previewDeckRawWaveformScrub,
  endDeckRawWaveformDrag
})
const {
  editBeatStep,
  canPreviousEditSong,
  canNextEditSong,
  loadEditAdjacentSong,
  jumpEditDeckByBeats
} = useHorizontalBrowseEditDeckNavigation({
  topDeckSong,
  assignSongToDeck,
  handleDeckBeatJump,
  resolveDeckPlaying,
  handleDeckPlayPauseToggle
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
const handleDeckQuantizeToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckQuantize(deck)
}
const handleSharedDetailZoomChange = (payload: HorizontalBrowseDetailZoomChangePayload) => {
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
const handleEditDetailZoomChange = (payload: HorizontalBrowseDetailZoomChangePayload) => {
  const numeric = Number(payload?.value)
  if (!Number.isFinite(numeric) || numeric <= 0) return
  editDetailZoomState.value = {
    value: Math.max(
      HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
      Math.min(HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM, numeric)
    ),
    anchorRatio: Math.max(0, Math.min(1, Number(payload?.anchorRatio) || 0)),
    sourceDirection: payload?.sourceDirection || null,
    revision: editDetailZoomState.value.revision + 1
  }
}
const handleDetailZoomChange = (payload: HorizontalBrowseDetailZoomChangePayload) => {
  if (!markDetailZoomPresentation(payload)) return
  if (horizontalBrowseViewMode.value === 'edit') {
    handleEditDetailZoomChange(payload)
    return
  }
  handleSharedDetailZoomChange(payload)
}
const shouldPreserveGridShiftPhase = (deck: DeckKey) => {
  const snapshot = resolveTransportDeckSnapshot(deck)
  return snapshot.syncEnabled && snapshot.syncLock === 'full'
}
const {
  handleToolbarStateChange,
  handleDeckBarLinePickingToggle,
  handleDeckSetBarLineAtPlayhead,
  handleDeckGridShiftLargeLeft,
  handleDeckGridShiftSmallLeft,
  handleDeckGridShiftSmallRight,
  handleDeckGridShiftLargeRight,
  handleDeckMetronomeStateCycle,
  handleDeckBpmTap,
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
  shouldPreserveGridShiftPhase,
  shouldCommitBpmInputAsGridEdit: (deck) => isEditMode.value && deck === 'top',
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
const resolveDeckToolbarState = (deck: DeckKey) =>
  buildHorizontalBrowseDeckToolbarState(
    deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value,
    resolveDeckToolbarBpmInputValue(deck),
    {
      loopBeatLabel: resolveDeckLoopBeatLabel(deck),
      loopActive: isDeckLoopActive(deck),
      loopDisabled: resolveDeckLoopDisabled(deck),
      bpmInputTitle: isEditMode.value ? EDIT_MODE_BPM_INPUT_TITLE : DUAL_MODE_BPM_INPUT_TITLE,
      bpmInputFirst: isEditMode.value,
      showTapButton: isEditMode.value,
      tapBpmTitle: isEditMode.value ? EDIT_MODE_TAP_BPM_TITLE : ''
    }
  )

const handleCrossfaderNudgeByKeyboard = (direction: -1 | 1) => {
  faderPanelRef.value?.nudgeCrossfaderByKeyboard(direction)
}
const handleCrossfaderResetByKeyboard = () => {
  faderPanelRef.value?.resetCrossfaderByKeyboard()
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
  onJumpEditBeats: jumpEditDeckByBeats,
  onMoveToFilter: handleDeckMoveToFilterHotkey,
  onMoveToCurated: handleDeckMoveToCuratedHotkey,
  onDelete: handleDeckDeleteHotkey,
  onSeekPercent: handleDeckSeekPercent,
  onNudgeCrossfader: handleCrossfaderNudgeByKeyboard,
  onResetCrossfader: handleCrossfaderResetByKeyboard,
  onNavigateEditSong: loadEditAdjacentSong
})

const {
  isDeckHovered,
  handleRegionDragEnter,
  handleRegionDragOver,
  handleRegionDragLeave,
  handleRegionDrop,
  handleGlobalDragFinish
} = useHorizontalBrowseDeckDrop({
  resolveSongsAreaStateBySongListUUID,
  resolveSongListSnapshot,
  assignSongToDeck
})

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

const {
  handleEditWaveformLoadingChange,
  handleMainWindowPlaybackSnapshotRequest,
  markPlaybackHandoffReady,
  clearPlaybackHandoffRuntimeState,
  syncDeckDataToPlayingData
} = useHorizontalBrowseModePlaybackHandoff({
  runtime,
  horizontalBrowseViewMode,
  deckSyncState,
  faderPanelRef,
  clearAllDeckCueMonitor,
  stopAllDeckCuePreview,
  resetAllDeckTempoNudgePlaybackRates,
  deactivateDualTransportSync,
  nativeTransport,
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckDurationSeconds,
  resolveTransportDeckSnapshot,
  setDeckSong,
  assignSongToDeck,
  notifyDeckSeekIntent: notifyDeckSeekPresentationIntent,
  commitDeckStateToNative,
  syncDeckRenderState,
  handleDeckPlayPauseToggle
})

const { handleSongsRemoved } = useHorizontalBrowseSongsRemoved({
  resolveDeckSong,
  handleDeckEjectSong
})

onMounted(() => {
  startSnapshotSync()
  void nativeTransport.reset().finally(() => {
    faderPanelRef.value?.syncCrossfaderValue(0)
    syncCurrentVolume()
    markPlaybackHandoffReady()
  })
  startRenderSyncLoop(handleDeckLoopPlaybackTick)
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  window.addEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.addEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.addEventListener('blur', stopAllDeckCuePreview)
  emitter.on(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, handleMainWindowPlaybackSnapshotRequest)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  emitter.on('songsRemoved', handleSongsRemoved)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.on('song-key-updated', handleSongKeyUpdated)
  window.electron.ipcRenderer.on('song-hot-cues-updated', handleSongHotCuesUpdated)
  window.electron.ipcRenderer.on('song-memory-cues-updated', handleSongMemoryCuesUpdated)
})

onUnmounted(() => {
  stopAllDeckCuePreview()
  stopAllDeckTempoNudge()
  clearPlaybackHandoffRuntimeState()
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
  emitter.off(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, handleMainWindowPlaybackSnapshotRequest)
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  emitter.off('songsRemoved', handleSongsRemoved)
  window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.removeListener('song-key-updated', handleSongKeyUpdated)
  window.electron.ipcRenderer.removeListener('song-hot-cues-updated', handleSongHotCuesUpdated)
  window.electron.ipcRenderer.removeListener(
    'song-memory-cues-updated',
    handleSongMemoryCuesUpdated
  )
  syncDeckDataToPlayingData()
  runtime.horizontalBrowseDecks.topSong = null
  runtime.horizontalBrowseDecks.bottomSong = null
  runtime.horizontalBrowseDecks.leaderDeck = null
  clearAllDeckSongListSources()
})
</script>

<template>
  <div
    class="horizontal-shell"
    :class="{
      'is-edit-mode': isEditMode,
      'is-light-theme': isLightTheme,
      'is-fader-controls-expanded': faderControlsExpanded && !isEditMode
    }"
  >
    <div class="controls" :class="{ 'controls--edit': isEditMode }">
      <HorizontalBrowseEditDeckControls
        v-if="isEditMode"
        v-model:beat-step="editBeatStep"
        :song-present="!!topDeckSong"
        :can-previous-song="canPreviousEditSong"
        :can-next-song="canNextEditSong"
        @previous-song="loadEditAdjacentSong(-1)"
        @next-song="loadEditAdjacentSong(1)"
        @jump-beats="jumpEditDeckByBeats"
      />

      <HorizontalBrowseDeckControlRow
        deck="top"
        :playing="topDeckPlayButtonActive"
        :decoding="topDeckUiDecoding"
        :pending-play="deckPendingPlayVisible.top"
        :pending-cue="deckPendingCuePreviewOnLoad.top"
        :cue-active="topDeckCueActive"
        :bands-visible="faderControlsExpanded && !isEditMode"
        :bands="deckBandState.top"
        :song-present="!!topDeckSong"
        :cue-monitor-enabled="deckCueMonitorState.top"
        @cue-pointer-down="handleDeckCuePointerDown('top', $event)"
        @cue-click="handleDeckCueClick('top')"
        @play-toggle="handleDeckPlayPauseToggle('top')"
        @toggle-band="handleDeckBandToggle"
        @toggle-cue-monitor="handleDeckCueMonitorToggle"
      />

      <HorizontalBrowseFaderPanel
        v-if="!isEditMode"
        ref="faderPanelRef"
        v-model:expanded="faderControlsExpanded"
        :native-transport="nativeTransport"
        :main-window-volume="mainWindowVolume"
        :transport-sync-enabled="dualTransportSyncEnabled || dualTransportSyncActivating"
        :transport-sync-disabled="!canUseDualTransportSync || dualTransportSyncActivating"
        @toggle-transport-sync="handleDualTransportSyncToggle"
      />

      <HorizontalBrowseDeckControlRow
        v-if="!isEditMode"
        deck="bottom"
        :playing="bottomDeckPlayButtonActive"
        :decoding="bottomDeckUiDecoding"
        :pending-play="deckPendingPlayVisible.bottom"
        :pending-cue="deckPendingCuePreviewOnLoad.bottom"
        :cue-active="bottomDeckCueActive"
        :bands-visible="faderControlsExpanded"
        :bands="deckBandState.bottom"
        :song-present="!!bottomDeckSong"
        :cue-monitor-enabled="deckCueMonitorState.bottom"
        @cue-pointer-down="handleDeckCuePointerDown('bottom', $event)"
        @cue-click="handleDeckCueClick('bottom')"
        @play-toggle="handleDeckPlayPauseToggle('bottom')"
        @toggle-band="handleDeckBandToggle"
        @toggle-cue-monitor="handleDeckCueMonitorToggle"
      />
    </div>

    <div class="waveform-stack" :class="{ 'waveform-stack--edit': isEditMode }">
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
        :tempo-nudge-active-direction="resolveDeckTempoNudgeDirection('top')"
        :show-tempo-nudge="!isEditMode"
        :hide-sync-controls="isEditMode"
        :show-large-shift-buttons="isEditMode"
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
        @tap-bpm="handleDeckBpmTap('top')"
        @memory-cue="void handleDeckMemoryCueCreate('top')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('top')"
        @cycle-metronome-state="handleDeckMetronomeStateCycle('top')"
        @loop-step-down="handleDeckLoopStepDown('top')"
        @loop-step-up="handleDeckLoopStepUp('top')"
        @toggle-loop="handleDeckLoopToggle('top')"
        @toggle-master-tempo="handleDeckMasterTempoToggle('top')"
        @reset-tempo="resetDeckTempo('top')"
        @toggle-quantize="handleDeckQuantizeToggle('top')"
        @tempo-nudge-start="startDeckTempoNudge('top', $event)"
        @tempo-nudge-end="stopDeckTempoNudge('top', $event)"
        @select-move-target="openDeckMoveDialog('top', $event)"
      />

      <section class="detail-pair" :class="{ 'detail-pair--edit': isEditMode }">
        <HorizontalBrowseDeckDetailLane
          ref="topDetailRef"
          :song="topDeckSong"
          :shared-zoom-state="isEditMode ? editDetailZoomState : sharedDetailZoomState"
          :current-seconds="topDeckRenderCurrentSeconds"
          :playing="topDeckUiPlaying"
          :playback-active="topDeckWaveformPlaybackActive"
          :playback-rate="topDeckPlaybackRate"
          :visual-playback-rate="resolveDeckPlaybackRateForTransport('top')"
          :waveform-gain="resolveDeckWaveformGain('top')"
          :playback-sync-revision="topDeckPlaybackSyncRevision"
          :grid-bpm="topDeckGridBpm"
          :loop-range="resolveDeckLoopRange('top')"
          :cue-seconds="topDeckCuePointSeconds"
          :hot-cues="topDeckSong?.hotCues || []"
          :memory-cues="topDeckSong?.memoryCues || []"
          :seek-target-seconds="deckSeekIntent.top.seconds"
          :seek-revision="deckSeekIntent.top.revision"
          :linked-drag-active="isDeckWaveformDragging('top')"
          :linked-drag-anchor-sec="resolveDeckWaveformDragAnchorSec('top')"
          :linked-grid-active="!isEditMode && shouldPreserveGridShiftPhase('top')"
          :linked-grid-visual-pending="dualTransportSyncActivating"
          :presentation-state="waveformPresentation.state.top"
          :max-zoom="
            isEditMode ? HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM : HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
          "
          :waveform-layout="isEditMode ? 'full' : 'auto'"
          waveform-render-style="raw-curve"
          allow-negative-timeline
          direction="up"
          :deck-hovered="isDeckHovered('top')"
          :region-id="4"
          @region-drag-enter="handleRegionDragEnter"
          @region-drag-over="handleRegionDragOver"
          @region-drag-leave="handleRegionDragLeave"
          @region-drop="handleRegionDrop"
          @toolbar-state-change="handleToolbarStateChange('top', $event)"
          @zoom-change="handleDetailZoomChange"
          @drag-session-start="handleDeckRawWaveformDragStart('top')"
          @drag-session-preview="handleDeckRawWaveformScrubPreview('top', $event)"
          @drag-session-end="handleDeckRawWaveformDragEnd('top', $event)"
          @edit-waveform-loading-change="handleEditWaveformLoadingChange"
        />
        <HorizontalBrowseDeckDetailLane
          v-if="!isEditMode"
          ref="bottomDetailRef"
          :song="bottomDeckSong"
          :shared-zoom-state="sharedDetailZoomState"
          :current-seconds="bottomDeckRenderCurrentSeconds"
          :playing="bottomDeckUiPlaying"
          :playback-active="bottomDeckWaveformPlaybackActive"
          :playback-rate="bottomDeckPlaybackRate"
          :visual-playback-rate="resolveDeckPlaybackRateForTransport('bottom')"
          :waveform-gain="resolveDeckWaveformGain('bottom')"
          :playback-sync-revision="bottomDeckPlaybackSyncRevision"
          :grid-bpm="bottomDeckGridBpm"
          :loop-range="resolveDeckLoopRange('bottom')"
          :cue-seconds="bottomDeckCuePointSeconds"
          :hot-cues="bottomDeckSong?.hotCues || []"
          :memory-cues="bottomDeckSong?.memoryCues || []"
          :seek-target-seconds="deckSeekIntent.bottom.seconds"
          :seek-revision="deckSeekIntent.bottom.revision"
          :linked-drag-active="isDeckWaveformDragging('bottom')"
          :linked-drag-anchor-sec="resolveDeckWaveformDragAnchorSec('bottom')"
          :linked-grid-active="shouldPreserveGridShiftPhase('bottom')"
          :linked-grid-visual-pending="dualTransportSyncActivating"
          :presentation-state="waveformPresentation.state.bottom"
          :max-zoom="HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM"
          waveform-layout="auto"
          waveform-render-style="raw-curve"
          allow-negative-timeline
          direction="down"
          :deck-hovered="isDeckHovered('bottom')"
          :region-id="5"
          @region-drag-enter="handleRegionDragEnter"
          @region-drag-over="handleRegionDragOver"
          @region-drag-leave="handleRegionDragLeave"
          @region-drop="handleRegionDrop"
          @toolbar-state-change="handleToolbarStateChange('bottom', $event)"
          @zoom-change="handleDetailZoomChange"
          @drag-session-start="handleDeckRawWaveformDragStart('bottom')"
          @drag-session-preview="handleDeckRawWaveformScrubPreview('bottom', $event)"
          @drag-session-end="handleDeckRawWaveformDragEnd('bottom', $event)"
        />
      </section>

      <HorizontalBrowseDeckOverviewSection
        v-if="!isEditMode"
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
        :tempo-nudge-active-direction="resolveDeckTempoNudgeDirection('bottom')"
        :show-tempo-nudge="!isEditMode"
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
        @tap-bpm="handleDeckBpmTap('bottom')"
        @memory-cue="void handleDeckMemoryCueCreate('bottom')"
        @toggle-bar-line-picking="handleDeckBarLinePickingToggle('bottom')"
        @cycle-metronome-state="handleDeckMetronomeStateCycle('bottom')"
        @loop-step-down="handleDeckLoopStepDown('bottom')"
        @loop-step-up="handleDeckLoopStepUp('bottom')"
        @toggle-loop="handleDeckLoopToggle('bottom')"
        @toggle-master-tempo="handleDeckMasterTempoToggle('bottom')"
        @reset-tempo="resetDeckTempo('bottom')"
        @toggle-quantize="handleDeckQuantizeToggle('bottom')"
        @tempo-nudge-start="startDeckTempoNudge('bottom', $event)"
        @tempo-nudge-end="stopDeckTempoNudge('bottom', $event)"
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
