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
import {
  useHorizontalBrowseDeckPlayers,
  type HorizontalBrowseDeckKey
} from '@renderer/components/useHorizontalBrowseDeckPlayers'
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
const topDetailRef = ref<any | null>(null)
const bottomDetailRef = ref<any | null>(null)
const faderRef = ref<HTMLElement | null>(null)
const topDeckToolbarState = ref<DeckToolbarState>(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref<DeckToolbarState>(createDefaultDeckToolbarState())
const topDeckBeatSyncActive = ref(false)
const topDeckMasterActive = ref(true)
const bottomDeckBeatSyncActive = ref(false)
const bottomDeckMasterActive = ref(false)
const hoveredDeckKey = ref<DeckKey | null>(null)
const faderDragging = ref(false)
const faderValue = ref(0)
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

const faderTicks = Array.from({ length: 9 }, (_, index) => ({
  id: index,
  major: index === 0 || index === 4 || index === 8,
  center: index === 4
}))

// 双轨横推区域编号约定，后续对话里默认按这套指代：
// 1: 上轨信息卡
// 2: 上轨全览波形
// 3: 上轨网格工具条
// 4: 上轨细节半波形
// 5: 下轨细节半波形
// 6: 下轨网格工具条
// 7: 下轨全览波形
// 8: 下轨信息卡
const topOverviewRegions = [1, 2, 3]
const bottomOverviewRegions = [6, 7, 8]
const deckHydrateToken = reactive<Record<DeckKey, number>>({
  top: 0,
  bottom: 0
})
const {
  topDeckCurrentSeconds,
  topDeckDurationSeconds,
  topDeckPlaying,
  topDeckCuePointSeconds,
  bottomDeckCurrentSeconds,
  bottomDeckDurationSeconds,
  bottomDeckPlaying,
  bottomDeckCuePointSeconds,
  loadDeckSong,
  setDeckVolume,
  syncDeckDefaultCue,
  seekDeck,
  toggleDeckPlayPause,
  cueDeck,
  stopDeck
} = useHorizontalBrowseDeckPlayers()

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

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
  setDeckVolume('top', volumes.top)
  setDeckVolume('bottom', volumes.bottom)
}

const syncCrossfaderValue = (value: number) => {
  faderValue.value = clampNumber(value, -1, 1)
  applyCrossfaderVolumes(faderValue.value)
}

const resolveCrossfaderValueByClientY = (clientY: number) => {
  const rect = faderRef.value?.getBoundingClientRect()
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
  const travelPercent = FADER_TRAVEL_INSET_RATIO * 100
  const usablePercent = 100 - travelPercent * 2
  return {
    top: `${travelPercent + (faderValue.value + 1) * 0.5 * usablePercent}%`
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
    stopDeck(deck)
  }
  if (deck === 'top') {
    topDeckSong.value = song
    runtime.horizontalBrowseDecks.topSong = song ? { ...song } : null
    return
  }
  bottomDeckSong.value = song
  runtime.horizontalBrowseDecks.bottomSong = song ? { ...song } : null
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
    }
  } catch {}
}

const assignSongToDeck = (deck: DeckKey, song: ISongInfo) => {
  const nextSong = { ...song }
  setDeckSong(deck, nextSong)
  syncDeckDefaultCue(deck, nextSong, true)
  loadDeckSong(deck, nextSong)
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
  seekDeck(deck, seconds)
}

const toggleDeckMaster = (deck: DeckKey) => {
  if (deck === 'top') {
    const nextActive = !topDeckMasterActive.value
    topDeckMasterActive.value = nextActive
    if (nextActive) {
      bottomDeckMasterActive.value = false
    }
    return
  }

  const nextActive = !bottomDeckMasterActive.value
  bottomDeckMasterActive.value = nextActive
  if (nextActive) {
    topDeckMasterActive.value = false
  }
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
}

onMounted(() => {
  syncCrossfaderValue(0)
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
})

onUnmounted(() => {
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
        <button
          type="button"
          class="deck-button deck-button--cue"
          @click="cueDeck('top', topDeckSong)"
        >
          CUE
        </button>
        <button
          type="button"
          class="deck-button deck-button--play"
          :class="{ 'is-active': topDeckPlaying }"
          @click="toggleDeckPlayPause('top')"
        >
          <svg v-if="topDeckPlaying" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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
            ></span>
          </div>
        </div>
        <div class="fader__rail">
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
            ></span>
          </div>
        </div>
      </div>

      <div class="deck-controls">
        <button
          type="button"
          class="deck-button deck-button--cue"
          @click="cueDeck('bottom', bottomDeckSong)"
        >
          CUE
        </button>
        <button
          type="button"
          class="deck-button deck-button--play"
          :class="{ 'is-active': bottomDeckPlaying }"
          @click="toggleDeckPlayPause('bottom')"
        >
          <svg v-if="bottomDeckPlaying" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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
            :beat-sync-active="topDeckBeatSyncActive"
            :master-active="topDeckMasterActive"
            :current-seconds="topDeckCurrentSeconds"
            :duration-seconds="topDeckDurationSeconds"
            @toggle-beat-sync="topDeckBeatSyncActive = !topDeckBeatSyncActive"
            @toggle-master="toggleDeckMaster('top')"
          />
          <HorizontalBrowseWaveformOverview
            v-else-if="regionId === 2"
            :song="topDeckSong"
            :current-seconds="topDeckCurrentSeconds"
            :duration-seconds="topDeckDurationSeconds"
            @seek="handleDeckPlayheadSeek('top', $event)"
          />
          <div v-else-if="regionId === 3" class="overview__toolbar-row">
            <MixtapeBeatAlignGridAdjustToolbar
              :disabled="topDeckToolbarState.disabled"
              :bpm-input-value="topDeckToolbarState.bpmInputValue"
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
            :current-seconds="topDeckCurrentSeconds"
            :playing="topDeckPlaying"
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
            :current-seconds="bottomDeckCurrentSeconds"
            :playing="bottomDeckPlaying"
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
              :bpm-input-value="bottomDeckToolbarState.bpmInputValue"
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
            :current-seconds="bottomDeckCurrentSeconds"
            :duration-seconds="bottomDeckDurationSeconds"
            @seek="handleDeckPlayheadSeek('bottom', $event)"
          />
          <HorizontalBrowseDeckInfoCard
            v-else-if="regionId === 8"
            :song="bottomDeckSong"
            :beat-sync-active="bottomDeckBeatSyncActive"
            :master-active="bottomDeckMasterActive"
            :current-seconds="bottomDeckCurrentSeconds"
            :duration-seconds="bottomDeckDurationSeconds"
            @toggle-beat-sync="bottomDeckBeatSyncActive = !bottomDeckBeatSyncActive"
            @toggle-master="toggleDeckMaster('bottom')"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.horizontal-shell {
  --shell-border: var(--border);
  --shell-panel: var(--bg);
  --shell-grid: rgba(255, 255, 255, 0.18);
  --shell-grid-major: rgba(255, 255, 255, 0.1);
  --shell-overview-waveform-bg: rgba(255, 255, 255, 0.06);
  --shell-play: #9fd6b3;
  --shell-drop-hover: rgba(0, 120, 212, 0.08);
  --shell-drop-border: rgba(0, 120, 212, 0.32);
  --fader-travel-inset: 17%;
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  background: var(--bg);
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}

:global(.theme-light) .horizontal-shell {
  --shell-grid: rgba(31, 31, 31, 0.12);
  --shell-grid-major: rgba(31, 31, 31, 0.08);
  --shell-overview-waveform-bg: var(--bg-elev);
  --shell-play: #79b592;
  --shell-drop-hover: rgba(0, 120, 212, 0.06);
  --shell-drop-border: rgba(0, 120, 212, 0.22);
}

.controls {
  display: grid;
  grid-template-rows: 100px minmax(0, 1fr) 100px;
  min-width: 0;
  height: 100%;
  border: 1px solid var(--shell-border);
  border-right: 0;
  background: var(--shell-panel);
  box-sizing: border-box;
}

.deck-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.deck-button {
  width: 36px;
  height: 36px;
  border: 1px solid var(--shell-border);
  border-radius: 50%;
  background: transparent;
  color: var(--text-weak);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  box-sizing: border-box;
}

.deck-button--cue {
  color: #d98921;
}

.deck-button--play {
  color: var(--shell-play);
}

.deck-button--play.is-active {
  border-color: rgba(122, 194, 145, 0.72);
  background: rgba(122, 194, 145, 0.12);
  box-shadow: inset 0 0 0 1px rgba(122, 194, 145, 0.08);
}

.deck-button svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

.fader {
  display: grid;
  grid-template-columns: 6px 24px 6px;
  justify-content: center;
  align-items: stretch;
  min-height: 0;
  padding: 2px 0;
  column-gap: 2px;
  box-sizing: border-box;
  touch-action: none;
}

.fader__scale {
  position: relative;
  min-height: 0;
}

.fader__scale-inner {
  position: absolute;
  top: var(--fader-travel-inset);
  bottom: var(--fader-travel-inset);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
}

.fader__tick {
  width: 4px;
  height: 1px;
  border-radius: 999px;
  background: var(--shell-grid);
}

.fader__tick.is-major {
  width: 6px;
  background: var(--shell-grid-major);
}

.fader__tick.is-center {
  width: 6px;
  height: 2px;
  background: var(--text);
}

.fader__rail {
  position: relative;
  min-height: 0;
}

.fader__slot {
  position: absolute;
  top: var(--fader-travel-inset);
  bottom: var(--fader-travel-inset);
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: var(--shell-grid-major);
}

.fader__thumb {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 26px;
  height: 4px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--shell-border);
  border-radius: 999px;
  background: var(--text);
  transition: top 0.08s ease;
}

.fader:hover .fader__thumb,
.fader.is-dragging .fader__thumb {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--border));
  background: color-mix(in srgb, var(--accent) 88%, var(--bg));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
}

.fader.is-dragging .fader__thumb {
  transition: none;
}

.waveform-stack {
  display: grid;
  grid-template-rows: minmax(0, 0.95fr) minmax(0, 1.1fr) minmax(0, 0.95fr);
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--shell-border);
  box-sizing: border-box;
  isolation: isolate;
}

.overview {
  display: grid;
  min-height: 0;
  background: var(--shell-panel);
  position: relative;
}

.overview--top {
  grid-template-rows: minmax(0, 1.46fr) minmax(0, 0.62fr) minmax(0, 0.92fr);
  z-index: 30;
}

.overview--bottom {
  grid-template-rows: minmax(0, 0.92fr) minmax(0, 0.62fr) minmax(0, 1.46fr);
  z-index: 10;
}

.overview__region {
  position: relative;
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.overview__region--deck-info {
  overflow: visible;
}

.overview--top .overview__region--deck-info {
  z-index: 10040;
}

.overview--bottom .overview__region--deck-info {
  z-index: 10010;
}

.overview__region--muted {
  padding: 0;
  background: var(--shell-overview-waveform-bg);
}

.overview__toolbar-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 24px 0 8px;
  box-sizing: border-box;
}

.overview__set-bar-btn {
  height: 24px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  line-height: 22px;
  white-space: nowrap;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease;
}

.overview__set-bar-btn:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__set-bar-btn.is-active {
  border-color: rgba(145, 205, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(145, 205, 255, 0.25) inset;
  background: rgba(145, 205, 255, 0.12);
}

.overview__set-bar-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.overview.is-deck-hover,
.detail-lane.is-deck-hover {
  background: var(--shell-drop-hover);
}

.overview.is-deck-hover {
  box-shadow: inset 0 0 0 1px var(--shell-drop-border);
}

.detail-lane.is-deck-hover {
  box-shadow: inset 0 0 0 1px var(--shell-drop-border);
}

.detail-pair {
  display: grid;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  row-gap: 2px;
  min-width: 0;
  min-height: 0;
  background: var(--shell-panel);
  position: relative;
  z-index: 20;
}

.detail-lane {
  position: relative;
  display: flex;
  align-items: stretch;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 1080px) {
  .horizontal-shell {
    grid-template-columns: 64px minmax(0, 1fr);
  }

  .controls {
    grid-template-rows: 94px minmax(0, 1fr) 94px;
  }

  .deck-button {
    width: 34px;
    height: 34px;
  }

  .fader {
    grid-template-columns: 5px 22px 5px;
  }

  .fader__thumb {
    width: 24px;
  }

  .waveform-stack {
    grid-template-rows: minmax(0, 0.96fr) minmax(0, 1.08fr) minmax(0, 0.96fr);
  }

  .overview--top {
    grid-template-rows: minmax(0, 1.4fr) minmax(0, 0.68fr) minmax(0, 0.92fr);
  }

  .overview--bottom {
    grid-template-rows: minmax(0, 0.92fr) minmax(0, 0.68fr) minmax(0, 1.4fr);
  }
}
</style>
