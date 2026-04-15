<script setup lang="ts">
import { computed } from 'vue'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import {
  formatSongHotCueTime,
  HOT_CUE_SLOT_COUNT,
  normalizeSongHotCues,
  resolveSongHotCueBySlot,
  resolveSongHotCueColor,
  resolveSongHotCueLabel
} from '@shared/hotCues'
import { formatSongMemoryCueTime, normalizeSongMemoryCues } from '@shared/memoryCues'

type DeckCuePanelMode = 'memory' | 'hot-cue'
type DeckKey = 'top' | 'bottom'

const props = defineProps<{
  topMode: DeckCuePanelMode
  bottomMode: DeckCuePanelMode
  topHotCues?: ISongHotCue[] | null
  bottomHotCues?: ISongHotCue[] | null
  topMemoryCues?: ISongMemoryCue[] | null
  bottomMemoryCues?: ISongMemoryCue[] | null
}>()

const emit = defineEmits<{
  (event: 'update:top-mode', value: DeckCuePanelMode): void
  (event: 'update:bottom-mode', value: DeckCuePanelMode): void
  (event: 'hotcue-press', payload: { deck: DeckKey; slot: number }): void
  (event: 'hotcue-delete', payload: { deck: DeckKey; slot: number }): void
  (event: 'memorycue-delete', payload: { deck: DeckKey; sec: number }): void
}>()

const buildHotCueRows = (hotCues: ISongHotCue[] | null | undefined) =>
  Array.from({ length: HOT_CUE_SLOT_COUNT }, (_, slot) => {
    const hotCue = resolveSongHotCueBySlot(normalizeSongHotCues(hotCues), slot)
    return {
      slot,
      label: resolveSongHotCueLabel(slot),
      color: resolveSongHotCueColor(slot),
      timeText: hotCue ? formatSongHotCueTime(hotCue.sec) : '--:--.---',
      active: !!hotCue
    }
  })

const panels = computed(() => [
  {
    deck: 'top' as DeckKey,
    mode: props.topMode,
    hotCueRows: buildHotCueRows(props.topHotCues),
    memoryCueRows: normalizeSongMemoryCues(props.topMemoryCues).map((item) => ({
      sec: item.sec,
      timeText: formatSongMemoryCueTime(item.sec)
    }))
  },
  {
    deck: 'bottom' as DeckKey,
    mode: props.bottomMode,
    hotCueRows: buildHotCueRows(props.bottomHotCues),
    memoryCueRows: normalizeSongMemoryCues(props.bottomMemoryCues).map((item) => ({
      sec: item.sec,
      timeText: formatSongMemoryCueTime(item.sec)
    }))
  }
])

const updateMode = (deck: DeckKey, mode: DeckCuePanelMode) => {
  if (deck === 'top') {
    emit('update:top-mode', mode)
    return
  }
  emit('update:bottom-mode', mode)
}
</script>

<template>
  <aside class="cue-panels">
    <section
      v-for="panel in panels"
      :key="panel.deck"
      class="cue-panel"
      :class="`cue-panel--${panel.deck}`"
    >
      <div class="cue-panel__placeholder">
        <div v-if="panel.mode === 'hot-cue'" class="cue-panel__hotcue-grid">
          <button
            v-for="row in panel.hotCueRows"
            :key="`${panel.deck}-${row.slot}`"
            type="button"
            class="cue-panel__hotcue-row"
            :class="{ 'has-value': row.active }"
            :style="{ '--cue-slot-color': row.color }"
            :title="`Hot Cue ${row.label} · ${row.timeText}`"
            @click="emit('hotcue-press', { deck: panel.deck, slot: row.slot })"
          >
            <span v-if="row.active" class="cue-panel__hotcue-label">
              {{ row.label }}
            </span>
            <span v-else class="cue-panel__hotcue-label-placeholder"></span>
            <span class="cue-panel__hotcue-time">{{ row.timeText }}</span>
            <button
              v-if="row.active"
              type="button"
              class="cue-panel__hotcue-delete"
              title="Delete Hot Cue"
              aria-label="Delete Hot Cue"
              @click.stop="emit('hotcue-delete', { deck: panel.deck, slot: row.slot })"
            >
              ×
            </button>
            <span v-else class="cue-panel__hotcue-delete-placeholder"></span>
          </button>
        </div>
        <div v-else class="cue-panel__memory-list">
          <div
            v-for="memoryCue in panel.memoryCueRows"
            :key="`${panel.deck}-${memoryCue.sec}`"
            class="cue-panel__memory-row"
            :title="`Memory Cue · ${memoryCue.timeText}`"
          >
            <span class="cue-panel__memory-time">{{ memoryCue.timeText }}</span>
            <button
              type="button"
              class="cue-panel__memory-delete"
              title="Delete Memory Cue"
              aria-label="Delete Memory Cue"
              @click.stop="emit('memorycue-delete', { deck: panel.deck, sec: memoryCue.sec })"
            >
              ×
            </button>
          </div>
          <div v-if="panel.memoryCueRows.length === 0" class="cue-panel__memory-empty"></div>
        </div>
      </div>

      <div class="cue-panel__mode-group">
        <button
          type="button"
          class="cue-panel__mode-btn"
          :class="{ 'is-active': panel.mode === 'memory' }"
          @click="updateMode(panel.deck, 'memory')"
        >
          MEMORY
        </button>
        <button
          type="button"
          class="cue-panel__mode-btn"
          :class="{ 'is-active': panel.mode === 'hot-cue' }"
          @click="updateMode(panel.deck, 'hot-cue')"
        >
          HOT CUE
        </button>
      </div>
    </section>
  </aside>
</template>

<style scoped lang="scss">
.cue-panels {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--shell-track-right-gutter);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: var(--shell-side-panel-gap);
  background: var(--shell-panel);
  pointer-events: none;
  z-index: 2;
}

.cue-panel {
  width: 100%;
  height: calc((100% - var(--shell-side-panel-gap)) / 2);
  padding: 6px 10px;
  background: var(--shell-side-panel-surface);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  box-sizing: border-box;
}

.cue-panel__placeholder {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: 3px;
  background: var(--shell-panel);
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: auto;
}

.cue-panel__memory-list {
  width: 100%;
  height: 100%;
  padding: 8px 6px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
  pointer-events: auto;
}

.cue-panel__memory-row {
  width: 100%;
  min-height: 16px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12px;
  align-items: center;
  column-gap: 6px;
}

.cue-panel__memory-time {
  min-width: 0;
  font-size: 9px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  color: var(--text);
}

.cue-panel__memory-delete {
  width: 12px;
  height: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-weak);
  font-size: 10px;
  line-height: 12px;
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.82;
  transition:
    color 0.14s ease,
    opacity 0.14s ease,
    background-color 0.14s ease;
}

.cue-panel__memory-delete:hover {
  color: #ffffff;
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

.cue-panel__memory-empty {
  flex: 1 1 auto;
  min-height: 0;
}

.cue-panel__hotcue-grid {
  width: 100%;
  height: 100%;
  padding: 4px 6px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.cue-panel__hotcue-row {
  flex: 1 1 12.5%;
  min-height: 0;
  padding: 0 4px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  background: transparent;
  color: var(--text-weak);
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 12px;
  align-items: center;
  column-gap: 6px;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
  pointer-events: auto;
}

.cue-panel__hotcue-row:last-child {
  border-bottom: 0;
}

.cue-panel__hotcue-row:hover {
  background: color-mix(in srgb, var(--cue-slot-color, var(--accent)) 12%, transparent);
}

.cue-panel__hotcue-row.has-value {
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--cue-slot-color, var(--accent));
}

.cue-panel__hotcue-label {
  width: 18px;
  height: 14px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--cue-slot-color, var(--accent)) 88%, #111111 12%);
  color: #ffffff;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
}

.cue-panel__hotcue-time {
  min-width: 0;
  font-size: 9px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}

.cue-panel__hotcue-label-placeholder {
  display: block;
  width: 18px;
  height: 14px;
}

.cue-panel__hotcue-delete,
.cue-panel__hotcue-delete-placeholder {
  width: 12px;
  height: 12px;
  justify-self: end;
}

.cue-panel__hotcue-delete {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-weak);
  font-size: 10px;
  line-height: 12px;
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.82;
  transition:
    color 0.14s ease,
    opacity 0.14s ease,
    background-color 0.14s ease;
}

.cue-panel__hotcue-delete:hover {
  color: #ffffff;
  opacity: 1;
  background: color-mix(in srgb, var(--cue-slot-color, var(--accent)) 18%, transparent);
}

.cue-panel__hotcue-delete-placeholder {
  display: block;
}

.cue-panel__mode-group {
  display: flex;
  align-items: center;
  justify-content: stretch;
  gap: 4px;
  width: 100%;
  pointer-events: auto;
}

.cue-panel__mode-btn {
  flex: 1 1 0;
  height: 16px;
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-weak);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1;
  white-space: nowrap;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.cue-panel__mode-btn:hover {
  border-color: rgba(255, 255, 255, 0.22);
}

.cue-panel__mode-btn.is-active {
  color: #ffffff;
  border-color: rgba(42, 144, 255, 0.95);
  background: linear-gradient(180deg, rgba(35, 137, 255, 0.96), rgba(0, 120, 212, 0.96));
  box-shadow:
    0 0 0 1px rgba(12, 84, 156, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.24);
}
</style>
