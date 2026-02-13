<script setup lang="ts">
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import MixtapeOutputDialog from '@renderer/components/mixtapeOutputDialog.vue'
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
  formatTrackBpm,
  isRawWaveformLoading,
  preRenderState,
  preRenderPercent,
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
    <div style="height: 35px">
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
                            :key="item.track.id"
                            class="lane-track"
                            :style="resolveTrackBlockStyle(item)"
                          >
                            <div class="lane-track__meta">
                              <div class="lane-track__meta-title">
                                {{ item.track.mixOrder }}. {{ resolveTrackTitle(item.track) }}
                              </div>
                              <div class="lane-track__meta-sub">
                                {{ t('mixtape.bpm') }} {{ formatTrackBpm(item.track.bpm) }}
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
                <div class="overview-viewport" :style="overviewViewportStyle"></div>
              </div>
            </div>
          </section>
        </div>
      </section>
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
}

.mixtape-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
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
  cursor: pointer;
  z-index: 5;

  &.is-selected {
    border-color: rgba(160, 160, 160, 0.9);
  }
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
  max-width: 70%;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.lane-track:hover .lane-track__meta {
  opacity: 1;
}

.lane-track__meta-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-track__meta-sub {
  font-size: 10px;
  color: var(--text-weak);
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
