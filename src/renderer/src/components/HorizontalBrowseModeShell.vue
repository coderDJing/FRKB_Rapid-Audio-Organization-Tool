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
  resolveHorizontalBrowseDeckSyncUiLock
} from '@renderer/components/horizontalBrowseShellState'
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
import { useHorizontalBrowseDeckTempoNudge } from '@renderer/components/useHorizontalBrowseDeckTempoNudge'
import { useHorizontalBrowseDeckToolbarInteractions } from '@renderer/components/useHorizontalBrowseDeckToolbarInteractions'
import type { HorizontalBrowseGridShiftOptions } from '@renderer/components/useHorizontalBrowseGridToolbar'
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

type DeckKey = HorizontalBrowseDeckKey
type HorizontalBrowseViewMode = 'dual' | 'edit'

type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}
type DeckCuePanelMode = 'memory' | 'hot-cue'
const EDIT_MODE_BPM_INPUT_TITLE = '网格 BPM：修改分析结果和网格线，不改变播放速度'
const DUAL_MODE_BPM_INPUT_TITLE = '目标 BPM：临时改变播放速度，不修改网格线'
const EDIT_MODE_TAP_BPM_TITLE = 'Tap：按节拍连续点击，实时修改网格 BPM，不改变播放速度'

type HorizontalBrowseDeckDetailLaneExpose = {
  toggleBarLinePicking?: () => void
  setBarLineAtPlayhead?: () => void
  shiftGridLargeLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput?: (value: string) => void
  blurBpmInput?: () => void
  tapBpm?: () => void
  cycleMetronomeState?: () => void
}
const props = withDefaults(
  defineProps<{
    viewMode?: HorizontalBrowseViewMode
  }>(),
  {
    viewMode: 'dual'
  }
)
const createDefaultDeckToolbarState = () => ({
  disabled: true,
  bpmInputValue: '',
  bpmStep: 0.01,
  bpmMin: 1,
  bpmMax: 300,
  bpmInputTitle: '',
  bpmInputFirst: false,
  showTapButton: false,
  tapBpmTitle: '',
  barLinePicking: false,
  metronomeEnabled: false,
  metronomeVolumeLevel: 2 as 1 | 2 | 3,
  canToggleMetronome: false
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
const faderPanelRef = ref<InstanceType<typeof HorizontalBrowseFaderPanel> | null>(null)
const topDeckToolbarState = ref(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref(createDefaultDeckToolbarState())
const sharedDetailZoomState = ref<SharedDetailZoomState>({
  value: HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  anchorRatio: 0.5,
  sourceDirection: null,
  revision: 0
})
const editDetailZoomState = ref<SharedDetailZoomState>({
  value: HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  anchorRatio: 0.5,
  sourceDirection: null,
  revision: 0
})
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
const {
  deckInteractionOrder,
  deckRecentInteraction,
  touchDeckInteraction,
  clearDeckRecentInteractionTimer
} = useHorizontalBrowseDeckInteractionState()

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
  notifyDeckSeekIntent
} = useHorizontalBrowseTransportController()

useHorizontalBrowseVisualizer({ nativeTransport })

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
const resolveDeckWaveformPlaybackActive = (deck: DeckKey) => {
  const snapshot = resolveTransportDeckSnapshot(deck)
  if (!snapshot.playing) return false
  if (snapshot.playingAudible || snapshot.playheadLoaded) return true
  const renderCurrentSec =
    deck === 'top' ? topDeckRenderCurrentSeconds.value : bottomDeckRenderCurrentSeconds.value
  return (
    Number(snapshot.renderCurrentSec) < -HORIZONTAL_BROWSE_NEGATIVE_PLAYBACK_EPSILON_SEC ||
    renderCurrentSec < -HORIZONTAL_BROWSE_NEGATIVE_PLAYBACK_EPSILON_SEC
  )
}
const topDeckWaveformPlaybackActive = computed(() => resolveDeckWaveformPlaybackActive('top'))
const bottomDeckWaveformPlaybackActive = computed(() => resolveDeckWaveformPlaybackActive('bottom'))
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
const resolveDeckToolbarBpmInputValue = (deck: DeckKey) => {
  const toolbarState = deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value
  if (deckTempoInputDirty[deck]) {
    return toolbarState.bpmInputValue
  }
  if (isEditMode.value) {
    const songBpm = Number(resolveDeckSong(deck)?.bpm)
    if (Number.isFinite(songBpm) && songBpm > 0) {
      return formatPreviewBpm(songBpm)
    }
    const baseGridBpm = Number(resolveDeckGridBpm(deck))
    if (Number.isFinite(baseGridBpm) && baseGridBpm > 0) {
      return formatPreviewBpm(baseGridBpm)
    }
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

const {
  resolveDeckPlaybackRateForTransport,
  resolveDeckTempoNudgeDirection,
  startDeckTempoNudge,
  stopDeckTempoNudge,
  stopAllDeckTempoNudge
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
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckDurationSeconds
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
  setDeckBeatGridToNative: nativeTransport.setBeatGrid,
  commitDeckStateToNative
})

const assignSongToDeck = async (
  deck: DeckKey,
  song: ISongInfo,
  sourceOptions?: HorizontalBrowseDeckSongSourceOptions
) => {
  setDeckSongListSource(deck, resolveDeckSongSourceOptions(sourceOptions))
  await assignSongToDeckBase(deck, song)
}

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
  handleDeckRawWaveformScrubPreview,
  handleDeckRawWaveformDragEnd,
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
  resolveDeckCuePlacementSec,
  resolveDualTransportSyncEnabled: () =>
    dualTransportSyncEnabled.value && canUseDualTransportSync.value,
  ensureDualTransportSync: activateDualTransportSync,
  deactivateDualTransportSync
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
  handleDeckBeatJump
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

const handleEditDetailZoomChange = (payload: {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down'
}) => {
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

const handleDetailZoomChange = (payload: {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down'
}) => {
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
  onMoveToFilter: handleDeckMoveToFilterHotkey,
  onMoveToCurated: handleDeckMoveToCuratedHotkey,
  onDelete: handleDeckDeleteHotkey,
  onSeekPercent: handleDeckSeekPercent,
  onNudgeCrossfader: handleCrossfaderNudgeByKeyboard,
  onResetCrossfader: handleCrossfaderResetByKeyboard
})

const enterEditMode = async () => {
  stopAllDeckCuePreview()
  faderPanelRef.value?.syncCrossfaderValue(0)
  if (resolveDeckPlaying('top')) {
    await nativeTransport.setPlaying('top', false)
  }
  setDeckSong('bottom', null)
  await commitDeckStateToNative('bottom', {
    currentSec: 0,
    durationSec: 0,
    playing: false,
    playbackRate: 1
  })
  if (deckSyncState.leaderDeck === 'bottom') {
    await nativeTransport.setLeader(resolveDeckSong('top') ? 'top' : null)
  }
  syncDeckRenderState({ force: 'all' })
}

watch(isEditMode, (editMode) => {
  if (!editMode) return
  clearAllDeckCueMonitor()
  void enterEditMode().catch((error) => {
    console.error('[horizontal-browse] enter edit mode failed', error)
  })
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

const { handleSongsRemoved } = useHorizontalBrowseSongsRemoved({
  resolveDeckSong,
  handleDeckEjectSong
})

onMounted(() => {
  startSnapshotSync()
  void nativeTransport.reset().finally(() => {
    faderPanelRef.value?.syncCrossfaderValue(0)
  })
  startRenderSyncLoop(handleDeckLoopPlaybackTick)
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  window.addEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.addEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.addEventListener('blur', stopAllDeckCuePreview)
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
  emitter.off('songsRemoved', handleSongsRemoved)
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
        :pending-play="deckPendingPlayOnLoad.top"
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
        v-model:expanded="faderControlsExpanded"
        ref="faderPanelRef"
        :native-transport="nativeTransport"
        :transport-sync-enabled="dualTransportSyncEnabled"
        :transport-sync-disabled="!canUseDualTransportSync"
        @toggle-transport-sync="handleDualTransportSyncToggle"
      />

      <HorizontalBrowseDeckControlRow
        v-if="!isEditMode"
        deck="bottom"
        :playing="bottomDeckPlayButtonActive"
        :decoding="bottomDeckUiDecoding"
        :pending-play="deckPendingPlayOnLoad.bottom"
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
          :playback-sync-revision="topDeckPlaybackSyncRevision"
          :grid-bpm="topDeckGridBpm"
          :loop-range="resolveDeckLoopRange('top')"
          :cue-seconds="topDeckCuePointSeconds"
          :hot-cues="topDeckSong?.hotCues || []"
          :memory-cues="topDeckSong?.memoryCues || []"
          :defer-waveform-load="topDeckShouldDeferWaveformLoad"
          :raw-load-priority-hint="topDeckRawLoadPriorityHint"
          :seek-target-seconds="deckSeekIntent.top.seconds"
          :seek-revision="deckSeekIntent.top.revision"
          :max-zoom="
            isEditMode ? HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM : HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
          "
          :waveform-layout="isEditMode ? 'full' : 'auto'"
          :waveform-render-style="isEditMode ? 'raw-curve' : 'columns'"
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
          :playback-sync-revision="bottomDeckPlaybackSyncRevision"
          :grid-bpm="bottomDeckGridBpm"
          :loop-range="resolveDeckLoopRange('bottom')"
          :cue-seconds="bottomDeckCuePointSeconds"
          :hot-cues="bottomDeckSong?.hotCues || []"
          :memory-cues="bottomDeckSong?.memoryCues || []"
          :defer-waveform-load="bottomDeckShouldDeferWaveformLoad"
          :raw-load-priority-hint="bottomDeckRawLoadPriorityHint"
          :seek-target-seconds="deckSeekIntent.bottom.seconds"
          :seek-revision="deckSeekIntent.bottom.revision"
          :max-zoom="HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM"
          waveform-layout="auto"
          waveform-render-style="columns"
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
