<script setup lang="ts">
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import MixtapeOutputDialog from '@renderer/components/mixtapeOutputDialog.vue'
import MixtapeBeatAlignDialog from '@renderer/components/mixtapeBeatAlignDialog.vue'
import { useMixtape } from '@renderer/composables/useMixtape'

const {
  t,
  titleLabel,
  mixtapeMenus,
  handleTitleOpenDialog,
  tracks,
  laneIndices,
  laneHeight,
  laneTracks,
  resolveTrackBlockStyle,
  resolveTrackTitle,
  resolveTrackTitleWithOriginalMeta,
  formatTrackBpm,
  formatTrackKey,
  isRawWaveformLoading,
  preRenderState,
  preRenderPercent,
  handleTrackDragStart,
  handleTrackContextMenu,
  trackContextMenuVisible,
  trackContextMenuStyle,
  handleTrackMenuAdjustGrid,
  handleTrackMenuToggleMasterTempo,
  trackMenuMasterTempoChecked,
  beatAlignDialogVisible,
  beatAlignTrack,
  handleBeatAlignDialogCancel,
  handleBeatAlignBarBeatOffsetUpdate,
  transportPlaying,
  transportDecoding,
  transportPreloading,
  transportPreloadDone,
  transportPreloadTotal,
  transportPreloadPercent,
  playheadVisible,
  playheadTimeLabel,
  timelineDurationLabel,
  rulerMinuteTicks,
  rulerInactiveStyle,
  overviewPlayheadStyle,
  rulerPlayheadStyle,
  timelinePlayheadStyle,
  handleTransportPlayFromStart,
  handleTransportStop,
  handleRulerSeek,
  transportError,
  timelineScrollWrapRef,
  isTimelinePanning,
  handleTimelinePanStart,
  timelineScrollRef,
  timelineScrollbarOptions,
  timelineViewport,
  timelineContentWidth,
  timelineScrollLeft,
  timelineViewportWidth,
  timelineCanvasRef,
  overviewRef,
  isOverviewDragging,
  handleOverviewMouseDown,
  handleOverviewClick,
  resolveOverviewTrackStyle,
  overviewViewportStyle,
  bpmAnalysisActive,
  bpmAnalysisFailed,
  bpmAnalysisFailedCount,
  outputDialogVisible,
  outputPath,
  outputFormat,
  outputFilename,
  handleOutputDialogConfirm,
  handleOutputDialogCancel
} = useMixtape()
</script>

<template>
  <div class="mixtape-shell">
    <div class="mixtape-title-wrap">
      <titleComponent
        control-prefix="mixtapeWindow"
        max-event-channel="mixtapeWindow-max"
        :title-text="titleLabel"
        :menu-override="mixtapeMenus"
        :enable-menu-hotkeys="false"
        @open-dialog="handleTitleOpenDialog"
      >
      </titleComponent>
    </div>
    <div class="mixtape-window">
      <section class="mixtape-body">
        <div class="mixtape-main">
          <section class="timeline">
            <div class="timeline-ruler-wrap">
              <div class="timeline-ruler-stop-float">
                <button
                  v-if="transportPlaying || transportDecoding"
                  class="timeline-stop-btn"
                  type="button"
                  :title="t('mixtape.stop')"
                  :aria-label="t('mixtape.stop')"
                  @mousedown.stop.prevent
                  @click.stop="handleTransportStop"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <rect x="4" y="4" width="8" height="8" rx="1"></rect>
                  </svg>
                </button>
                <button
                  v-else
                  class="timeline-stop-btn"
                  type="button"
                  :title="t('player.play')"
                  :aria-label="t('player.play')"
                  @mousedown.stop.prevent
                  @click.stop="handleTransportPlayFromStart"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <polygon points="5,4 12,8 5,12"></polygon>
                  </svg>
                </button>
                <span v-if="transportDecoding" class="timeline-decoding-hint">
                  {{ t('mixtape.transportDecoding') }}
                </span>
              </div>
              <div class="timeline-ruler" @mousedown="handleRulerSeek">
                <div class="timeline-ruler__ticks">
                  <div
                    v-for="tick in rulerMinuteTicks"
                    :key="`minute-${tick.value}-${tick.left}`"
                    class="timeline-ruler__tick"
                    :style="{ left: tick.left }"
                  >
                    <div class="timeline-ruler__tick-line"></div>
                    <div class="timeline-ruler__tick-label">{{ tick.value }}</div>
                  </div>
                </div>
                <div class="timeline-ruler__label">
                  {{ playheadTimeLabel }} / {{ timelineDurationLabel }}
                </div>
                <div
                  v-if="rulerInactiveStyle"
                  class="timeline-ruler__inactive"
                  :style="rulerInactiveStyle"
                ></div>
                <div
                  v-if="playheadVisible"
                  class="timeline-ruler__playhead"
                  :style="rulerPlayheadStyle"
                ></div>
              </div>
            </div>
            <div
              ref="timelineScrollWrapRef"
              class="timeline-scroll-wrap"
              :class="{ 'is-panning': isTimelinePanning }"
              @mousedown="handleTimelinePanStart"
            >
              <OverlayScrollbarsComponent
                ref="timelineScrollRef"
                class="timeline-scroll"
                :options="timelineScrollbarOptions"
                element="div"
                defer
              >
                <div
                  ref="timelineViewport"
                  class="timeline-viewport"
                  :style="{
                    width: `${timelineContentWidth}px`,
                    '--timeline-scroll-left': `${timelineScrollLeft}px`,
                    '--timeline-viewport-width': `${timelineViewportWidth}px`
                  }"
                >
                  <div class="timeline-lanes">
                    <div v-if="tracks.length === 0" class="timeline-empty">
                      <div>{{ t('mixtape.trackEmpty') }}</div>
                      <div class="timeline-empty-hint">{{ t('mixtape.trackEmptyHint') }}</div>
                    </div>
                    <template v-else>
                      <div v-for="laneIndex in laneIndices" :key="laneIndex" class="timeline-lane">
                        <div
                          class="lane-body"
                          :style="{ height: `${laneHeight}px`, minHeight: `${laneHeight}px` }"
                        >
                          <div
                            v-for="item in laneTracks[laneIndex]"
                            :key="`${item.track.id}-${item.startX}`"
                            class="lane-track"
                            :style="resolveTrackBlockStyle(item)"
                            @mousedown.stop="handleTrackDragStart(item, $event)"
                            @contextmenu.stop.prevent="handleTrackContextMenu(item, $event)"
                          >
                            <div class="lane-track__meta">
                              <div class="lane-track__meta-title">
                                {{ item.track.mixOrder }}.
                                {{ resolveTrackTitleWithOriginalMeta(item.track) }}
                              </div>
                              <div class="lane-track__meta-sub">
                                {{ t('mixtape.bpm') }} {{ formatTrackBpm(item.track.bpm) }}
                                <template v-if="formatTrackKey(item.track.key)">
                                  · {{ t('columns.key') }} {{ formatTrackKey(item.track.key) }}
                                </template>
                              </div>
                            </div>
                            <div v-if="isRawWaveformLoading(item.track)" class="lane-loading">
                              {{ t('mixtape.rawWaveformLoading') }}
                            </div>
                          </div>
                        </div>
                      </div>
                    </template>
                  </div>
                  <div
                    v-if="playheadVisible && timelinePlayheadStyle"
                    class="timeline-playhead"
                    :style="timelinePlayheadStyle"
                  ></div>
                </div>
              </OverlayScrollbarsComponent>
              <canvas ref="timelineCanvasRef" class="timeline-waveform-canvas"></canvas>
              <div v-if="preRenderState.active" class="timeline-preload">
                <div class="preload-card">
                  <div class="preload-title">
                    {{ t('mixtape.waveformPreparing') }} {{ preRenderPercent }}%
                  </div>
                  <div class="preload-bar">
                    <div class="preload-bar__fill" :style="{ width: `${preRenderPercent}%` }"></div>
                  </div>
                  <div class="preload-sub">
                    {{ preRenderState.done }} / {{ preRenderState.total }}
                  </div>
                </div>
              </div>
            </div>
            <div v-if="transportError" class="timeline-transport-error">
              {{ transportError }}
            </div>
            <div class="timeline-overview">
              <div
                ref="overviewRef"
                class="overview-stage"
                :class="{ 'is-dragging': isOverviewDragging }"
                @mousedown="handleOverviewMouseDown"
                @click="handleOverviewClick"
              >
                <div class="overview-lanes">
                  <div
                    v-for="laneIndex in laneIndices"
                    :key="`overview-${laneIndex}`"
                    class="overview-lane"
                  >
                    <div
                      v-for="item in laneTracks[laneIndex]"
                      :key="`overview-${item.track.id}`"
                      class="overview-track"
                      :style="resolveOverviewTrackStyle(item)"
                    ></div>
                  </div>
                </div>
                <div
                  v-if="playheadVisible"
                  class="overview-playhead"
                  :style="overviewPlayheadStyle"
                ></div>
                <div class="overview-viewport" :style="overviewViewportStyle"></div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
    <div v-if="transportPreloading" class="mixtape-decode-mask">
      <div class="bpm-loading-card">
        <div class="bpm-loading-title">{{ t('mixtape.transportPreloading') }}</div>
        <div class="bpm-loading-sub">{{ t('mixtape.transportPreloadingHint') }}</div>
        <div class="bpm-loading-sub">
          {{
            t('mixtape.transportPreloadingProgress', {
              done: transportPreloadDone,
              total: transportPreloadTotal,
              percent: transportPreloadPercent
            })
          }}
        </div>
      </div>
    </div>
    <div v-if="bpmAnalysisActive" class="mixtape-bpm-mask">
      <div class="bpm-loading-card">
        <div class="bpm-loading-title">{{ t('mixtape.bpmAnalyzing') }}</div>
        <div class="bpm-loading-sub">{{ t('mixtape.bpmAnalyzingHint') }}</div>
      </div>
    </div>
    <div v-else-if="bpmAnalysisFailed" class="mixtape-bpm-failed">
      <div class="bpm-loading-card is-error">
        <div class="bpm-loading-title">{{ t('mixtape.bpmAnalyzeFailed') }}</div>
        <div class="bpm-loading-sub">
          {{ t('mixtape.bpmAnalyzeFailedHint', { count: bpmAnalysisFailedCount }) }}
        </div>
      </div>
    </div>
    <MixtapeOutputDialog
      v-if="outputDialogVisible"
      :output-path="outputPath"
      :output-format="outputFormat"
      :output-filename="outputFilename"
      @confirm="handleOutputDialogConfirm"
      @cancel="handleOutputDialogCancel"
    />
    <div
      v-if="trackContextMenuVisible"
      class="mixtape-track-menu"
      :style="trackContextMenuStyle"
      @contextmenu.stop.prevent
    >
      <button class="mixtape-track-menu__item" type="button" @click="handleTrackMenuAdjustGrid">
        {{ t('mixtape.adjustGridMenu') }}
      </button>
      <button
        class="mixtape-track-menu__item"
        type="button"
        @click="handleTrackMenuToggleMasterTempo"
      >
        <span class="mixtape-track-menu__check">{{ trackMenuMasterTempoChecked ? '✓' : '' }}</span>
        <span>{{ t('mixtape.masterTempoMenu') }}</span>
      </button>
    </div>
    <MixtapeBeatAlignDialog
      v-if="beatAlignDialogVisible && beatAlignTrack"
      :track-title="resolveTrackTitle(beatAlignTrack)"
      :track-key="beatAlignTrack.key"
      :file-path="beatAlignTrack.filePath"
      :bpm="Number(beatAlignTrack.originalBpm) || Number(beatAlignTrack.bpm) || 128"
      :first-beat-ms="Number(beatAlignTrack.firstBeatMs) || 0"
      :bar-beat-offset="Number(beatAlignTrack.barBeatOffset) || 0"
      @update-bar-beat-offset="handleBeatAlignBarBeatOffsetUpdate"
      @cancel="handleBeatAlignDialogCancel"
    />
  </div>
</template>

<style scoped lang="scss">
.mixtape-window {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
  position: relative;
  z-index: 1;
}

.mixtape-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

.mixtape-title-wrap {
  height: 35px;
  position: relative;
  z-index: 10030;
  overflow: visible;
}

.title-drag {
  flex-grow: 1;
  height: 35px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 12px 0 8px;
  min-width: 0;
}

.title-meta {
  font-size: 12px;
  color: var(--text-weak);
  max-width: 60%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  pointer-events: none;
}

:global(#app) {
  color: var(--text);
  background-color: var(--bg);
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

:global(body) {
  margin: 0;
  background-color: var(--bg-elev);
  overflow: hidden;
}

.mixtape-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  padding: 0;
  min-height: 0;
}

.mixtape-main {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  gap: 0;
  min-height: 0;
}

.timeline {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: hidden;
}

.timeline-ruler-wrap {
  display: flex;
  align-items: center;
  position: relative;
  padding: 8px 0 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.timeline-ruler-stop-float {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.timeline-decoding-hint {
  font-size: 11px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
  animation: decoding-pulse 1.2s ease-in-out infinite;
}

@keyframes decoding-pulse {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

.timeline-stop-btn {
  height: 22px;
  width: 22px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.45);
  color: var(--text);
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.timeline-stop-btn:hover {
  border-color: var(--accent);
}

.timeline-stop-btn svg {
  width: 11px;
  height: 11px;
  fill: currentColor;
}

.timeline-ruler {
  position: relative;
  flex: 1;
  height: 30px;
  border: 1px solid var(--border);
  background: linear-gradient(to right, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.01));
  cursor: pointer;
  overflow: hidden;
  user-select: none;
}

.timeline-ruler__ticks {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.timeline-ruler__tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  transform: translateX(0);
}

.timeline-ruler__tick-line {
  position: absolute;
  top: 2px;
  bottom: 13px;
  left: 0;
  width: 1px;
  transform: translateX(-50%);
  background: repeating-linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.32) 0 3px,
    rgba(255, 255, 255, 0) 3px 6px
  );
}

.timeline-ruler__tick-label {
  position: absolute;
  bottom: 2px;
  left: 0;
  transform: translateX(-50%);
  font-size: 10px;
  line-height: 10px;
  color: var(--text-weak);
  text-align: center;
  white-space: nowrap;
}

.timeline-ruler__label {
  position: absolute;
  right: 8px;
  top: 4px;
  font-size: 11px;
  color: var(--text-weak);
  z-index: 1;
  pointer-events: none;
}

.timeline-ruler__inactive {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.1);
  pointer-events: none;
  z-index: 0;
}

.timeline-ruler__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 84, 84, 0.95);
  pointer-events: none;
  z-index: 2;
}

.timeline-scroll {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
  position: relative;
  z-index: 3;
}

.timeline-scroll-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
  cursor: grab;
}

.timeline-scroll-wrap.is-panning {
  cursor: grabbing;
}

.timeline-waveform-canvas {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 1;
  pointer-events: none;
}

.timeline-preload {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
  pointer-events: none;
}

.mixtape-bpm-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  pointer-events: auto;
  cursor: progress;
  background: rgba(8, 8, 12, 0.96);
}

.mixtape-decode-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 24;
  pointer-events: auto;
  cursor: progress;
  background: rgba(8, 8, 12, 0.9);
}

.mixtape-bpm-failed {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 18;
  pointer-events: none;
  background: rgba(8, 8, 12, 0.6);
}

.timeline-overview {
  border-top: 1px solid var(--border);
  padding: 8px 0 12px;
  background: var(--bg);
}

.overview-stage {
  position: relative;
  width: 100%;
  background: rgba(0, 0, 0, 0.18);
  cursor: grab;
  user-select: none;
}

.overview-stage.is-dragging {
  cursor: grabbing;
}

.overview-lanes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
}

.overview-lane {
  position: relative;
  height: 12px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.overview-track {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: rgba(0, 120, 212, 0.55);
}

.overview-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 84, 84, 0.95);
  pointer-events: none;
  z-index: 5;
}

.overview-viewport {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 0;
  border-radius: 4px;
  border: 1px solid rgba(0, 120, 212, 0.9);
  background: rgba(0, 120, 212, 0.16);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2) inset;
  opacity: 1;
  transition: opacity 0.12s ease;
  pointer-events: none;
  will-change: transform;
}

.preload-card {
  min-width: 240px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: center;
}

.preload-title {
  font-size: 12px;
  color: var(--text);
}

.preload-bar {
  width: 240px;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.preload-bar__fill {
  height: 100%;
  width: 0%;
  background: var(--accent);
  transition: width 0.12s ease;
}

.preload-sub {
  font-size: 11px;
  color: var(--text-weak);
}

.bpm-loading-card {
  min-width: 220px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: center;
}

.bpm-loading-card.is-error {
  background: rgba(80, 10, 10, 0.7);
  border-color: rgba(255, 120, 120, 0.25);
}

.bpm-loading-title {
  font-size: 12px;
  color: var(--text);
}

.bpm-loading-sub {
  font-size: 11px;
  color: var(--text-weak);
}

.timeline-viewport {
  position: relative;
  min-height: 100%;
}

.timeline-lanes {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0 0 0;
  min-height: 100%;
  z-index: 4;
}

.timeline-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: rgba(255, 84, 84, 0.95);
  pointer-events: none;
  z-index: 8;
}

:global(.timeline-scroll .os-scrollbar-vertical) {
  right: 0;
}

:global(.timeline-scroll .os-scrollbar-horizontal) {
  display: none;
}

:global(.timeline-scroll .os-content) {
  display: block;
  min-height: 100%;
  width: 100% !important;
}

.timeline-lane {
  position: relative;
  min-height: 34px;
}

.lane-body {
  width: 100%;
  height: 100%;
  border: 1px dashed var(--border);
  border-radius: 0;
  background: transparent;
  overflow: visible;
  position: relative;
}

.lane-track {
  position: absolute;
  left: 0;
  top: -1px;
  height: calc(100% + 2px);
  border-radius: 0;
  box-sizing: border-box;
  border: 2px solid transparent;
  cursor: ew-resize;
  z-index: 5;

  &.is-selected {
    border-color: rgba(160, 160, 160, 0.9);
  }
}

.timeline-transport-error {
  padding: 4px 12px 0;
  font-size: 11px;
  color: #f08989;
}

.lane-track:hover {
  border-color: rgba(170, 170, 170, 0.95);
}

.lane-track__meta {
  position: absolute;
  left: max(6px, calc(var(--timeline-scroll-left, 0px) - var(--track-start, 0px) + 6px));
  top: 6px;
  padding: 4px 8px;
  border-radius: 0;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  font-size: 11px;
  color: rgba(230, 230, 230, 0.98);
  background: #2b2b2b;
  pointer-events: none;
  z-index: 6;
  width: max-content;
  max-width: none;
  min-width: 0;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.lane-track:hover .lane-track__meta {
  opacity: 1;
}

.lane-track__meta-title {
  display: block;
  max-width: none;
  white-space: nowrap;
  overflow: visible;
  text-overflow: clip;
  overflow-wrap: normal;
  word-break: normal;
  line-height: 1.25;
}

.lane-track__meta-sub {
  font-size: 10px;
  color: var(--text-weak);
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lane-loading {
  position: absolute;
  right: 8px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--text-weak);
  background: rgba(0, 0, 0, 0.25);
  pointer-events: none;
  z-index: 3;
}

.mixtape-track-menu {
  position: fixed;
  z-index: 10060;
  min-width: 140px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.38);
  padding: 4px;
}

.mixtape-track-menu__item {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 12px;
  line-height: 28px;
  padding: 0 8px;
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.mixtape-track-menu__item:hover {
  background: var(--hover);
}

.mixtape-track-menu__check {
  width: 14px;
  text-align: center;
  color: var(--accent);
}

.timeline-empty {
  text-align: center;
  color: var(--text-weak);
  font-size: 12px;
  padding: 32px 0;
}

.timeline-empty-hint {
  margin-top: 6px;
  opacity: 0.75;
  font-size: 12px;
}
</style>
