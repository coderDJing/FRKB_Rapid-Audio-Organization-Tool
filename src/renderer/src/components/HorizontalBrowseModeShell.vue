<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckInfoCard from '@renderer/components/HorizontalBrowseDeckInfoCard.vue'
import HorizontalBrowseRawWaveformDetail from '@renderer/components/HorizontalBrowseRawWaveformDetail.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import MixtapeBeatAlignGridAdjustToolbar from '@renderer/components/mixtapeBeatAlignGridAdjustToolbar.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'

type DeckKey = 'top' | 'bottom'
type HorizontalBrowseLoadSongPayload = {
  deck?: DeckKey
  song?: ISongInfo | null
}

const runtime = useRuntimeStore()
const topDeckSong = ref<ISongInfo | null>(null)
const bottomDeckSong = ref<ISongInfo | null>(null)
const topDeckBeatSyncActive = ref(false)
const topDeckMasterActive = ref(true)
const bottomDeckBeatSyncActive = ref(false)
const bottomDeckMasterActive = ref(false)
const hoveredDeckKey = ref<DeckKey | null>(null)
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
  major: index === 0 || index === 4 || index === 8
}))

const topOverviewRegions = [1, 2, 3]
const bottomOverviewRegions = [6, 7, 8]

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

const assignSongToDeck = (deck: DeckKey, song: ISongInfo) => {
  if (deck === 'top') {
    topDeckSong.value = song
    return
  }
  bottomDeckSong.value = song
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

onMounted(() => {
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
})

onUnmounted(() => {
  window.removeEventListener('drop', handleGlobalDragFinish, true)
  window.removeEventListener('dragend', handleGlobalDragFinish, true)
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
})
</script>

<template>
  <div class="horizontal-shell">
    <div class="controls">
      <div class="deck-controls">
        <button type="button" class="deck-button deck-button--cue">CUE</button>
        <button type="button" class="deck-button deck-button--play">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
          </svg>
        </button>
      </div>

      <div class="fader">
        <div class="fader__scale">
          <div class="fader__scale-inner">
            <span
              v-for="tick in faderTicks"
              :key="`left-${tick.id}`"
              class="fader__tick"
              :class="{ 'is-major': tick.major }"
            ></span>
          </div>
        </div>
        <div class="fader__rail">
          <div class="fader__slot"></div>
          <div class="fader__thumb"></div>
        </div>
        <div class="fader__scale">
          <div class="fader__scale-inner">
            <span
              v-for="tick in faderTicks"
              :key="`right-${tick.id}`"
              class="fader__tick"
              :class="{ 'is-major': tick.major }"
            ></span>
          </div>
        </div>
      </div>

      <div class="deck-controls">
        <button type="button" class="deck-button deck-button--cue">CUE</button>
        <button type="button" class="deck-button deck-button--play">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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
            @toggle-beat-sync="topDeckBeatSyncActive = !topDeckBeatSyncActive"
            @toggle-master="toggleDeckMaster('top')"
          />
          <HorizontalBrowseWaveformOverview v-else-if="regionId === 2" :song="topDeckSong" />
          <div v-else-if="regionId === 3" class="overview__toolbar-row">
            <MixtapeBeatAlignGridAdjustToolbar
              bpm-input-value="128.00"
              :bpm-step="0.01"
              :bpm-min="1"
              :bpm-max="300"
            />
            <button type="button" class="overview__set-bar-btn">
              {{ t('mixtape.gridAdjustSetBarLine') }}
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
          <HorizontalBrowseRawWaveformDetail :song="topDeckSong" direction="up" />
        </div>

        <div
          class="detail-lane drop-zone"
          :class="{ 'is-deck-hover': isDeckHovered('bottom') }"
          @dragenter.stop.prevent="handleRegionDragEnter(5, $event)"
          @dragover.stop.prevent="handleRegionDragOver(5, $event)"
          @dragleave.stop="handleRegionDragLeave(5, $event)"
          @drop.stop.prevent="handleRegionDrop(5, $event)"
        >
          <HorizontalBrowseRawWaveformDetail :song="bottomDeckSong" direction="down" />
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
              bpm-input-value="128.00"
              :bpm-step="0.01"
              :bpm-min="1"
              :bpm-max="300"
            />
            <button type="button" class="overview__set-bar-btn">
              {{ t('mixtape.gridAdjustSetBarLine') }}
            </button>
          </div>
          <HorizontalBrowseWaveformOverview v-else-if="regionId === 7" :song="bottomDeckSong" />
          <HorizontalBrowseDeckInfoCard
            v-else-if="regionId === 8"
            :song="bottomDeckSong"
            :beat-sync-active="bottomDeckBeatSyncActive"
            :master-active="bottomDeckMasterActive"
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
