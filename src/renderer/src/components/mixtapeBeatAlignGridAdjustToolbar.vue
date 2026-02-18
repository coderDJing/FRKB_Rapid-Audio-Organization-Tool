<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { t } from '@renderer/utils/translate'

const props = defineProps({
  disabled: {
    type: Boolean,
    default: false
  },
  bpmInputValue: {
    type: String,
    default: ''
  },
  bpmStep: {
    type: Number,
    default: 0.01
  },
  bpmMin: {
    type: Number,
    default: 1
  },
  bpmMax: {
    type: Number,
    default: 300
  }
})

const emit = defineEmits<{
  (event: 'set-bar-line'): void
  (event: 'shift-left-large'): void
  (event: 'shift-left-small'): void
  (event: 'shift-right-small'): void
  (event: 'shift-right-large'): void
  (event: 'update-bpm-input', value: string): void
  (event: 'blur-bpm-input'): void
  (event: 'tap-bpm'): void
}>()

type ShiftEventName =
  | 'shift-left-large'
  | 'shift-left-small'
  | 'shift-right-small'
  | 'shift-right-large'

const HOLD_START_DELAY_MS = 1000
const HOLD_INTERVAL_MS = 250

let holdStartTimer: ReturnType<typeof setTimeout> | null = null
let holdRepeatTimer: ReturnType<typeof setInterval> | null = null
let holdEventName: ShiftEventName | null = null
let suppressNextClick = false

const clearShiftHold = () => {
  if (holdStartTimer) {
    clearTimeout(holdStartTimer)
    holdStartTimer = null
  }
  if (holdRepeatTimer) {
    clearInterval(holdRepeatTimer)
    holdRepeatTimer = null
  }
  holdEventName = null
}

const emitShift = (eventName: ShiftEventName) => {
  if (props.disabled) return
  if (eventName === 'shift-left-large') {
    emit('shift-left-large')
    return
  }
  if (eventName === 'shift-left-small') {
    emit('shift-left-small')
    return
  }
  if (eventName === 'shift-right-small') {
    emit('shift-right-small')
    return
  }
  emit('shift-right-large')
}

const handleShiftPointerDown = (eventName: ShiftEventName) => {
  if (props.disabled) return
  clearShiftHold()
  holdEventName = eventName
  suppressNextClick = false
  holdStartTimer = setTimeout(() => {
    if (!holdEventName || props.disabled) return
    suppressNextClick = true
    emitShift(holdEventName)
    holdRepeatTimer = setInterval(() => {
      if (!holdEventName || props.disabled) return
      emitShift(holdEventName)
    }, HOLD_INTERVAL_MS)
  }, HOLD_START_DELAY_MS)
}

const handleShiftPointerEnd = () => {
  clearShiftHold()
}

const handleShiftClick = (eventName: ShiftEventName) => {
  if (props.disabled) return
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  emitShift(eventName)
}

const handleBpmInput = (event: Event) => {
  const target = event.target as HTMLInputElement | null
  emit('update-bpm-input', target?.value || '')
}

const handleBpmInputEnter = (event: KeyboardEvent) => {
  const target = event.target as HTMLInputElement | null
  target?.blur()
}

onBeforeUnmount(() => {
  clearShiftHold()
})
</script>

<template>
  <div class="grid-adjust-toolbar">
    <button
      class="grid-adjust-icon-btn"
      type="button"
      :disabled="disabled"
      :title="t('mixtape.gridAdjustSetBarLineAtPlayhead')"
      :aria-label="t('mixtape.gridAdjustSetBarLineAtPlayhead')"
      @click="emit('set-bar-line')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3 2v12"></path>
        <path d="M8 1v14"></path>
        <path d="M13 2v12"></path>
      </svg>
    </button>
    <button
      class="grid-adjust-icon-btn"
      type="button"
      :disabled="disabled"
      :title="t('mixtape.gridAdjustShiftLeftLarge')"
      :aria-label="t('mixtape.gridAdjustShiftLeftLarge')"
      @click="handleShiftClick('shift-left-large')"
      @pointerdown="handleShiftPointerDown('shift-left-large')"
      @pointerup="handleShiftPointerEnd"
      @pointercancel="handleShiftPointerEnd"
      @pointerleave="handleShiftPointerEnd"
      @lostpointercapture="handleShiftPointerEnd"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M11.5 3.5 7.8 8l3.7 4.5"></path>
        <path d="M8.1 3.5 4.4 8l3.7 4.5"></path>
      </svg>
    </button>
    <button
      class="grid-adjust-icon-btn"
      type="button"
      :disabled="disabled"
      :title="t('mixtape.gridAdjustShiftLeftSmall')"
      :aria-label="t('mixtape.gridAdjustShiftLeftSmall')"
      @click="handleShiftClick('shift-left-small')"
      @pointerdown="handleShiftPointerDown('shift-left-small')"
      @pointerup="handleShiftPointerEnd"
      @pointercancel="handleShiftPointerEnd"
      @pointerleave="handleShiftPointerEnd"
      @lostpointercapture="handleShiftPointerEnd"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M10.5 3.5 6 8l4.5 4.5"></path>
      </svg>
    </button>
    <button
      class="grid-adjust-icon-btn"
      type="button"
      :disabled="disabled"
      :title="t('mixtape.gridAdjustShiftRightSmall')"
      :aria-label="t('mixtape.gridAdjustShiftRightSmall')"
      @click="handleShiftClick('shift-right-small')"
      @pointerdown="handleShiftPointerDown('shift-right-small')"
      @pointerup="handleShiftPointerEnd"
      @pointercancel="handleShiftPointerEnd"
      @pointerleave="handleShiftPointerEnd"
      @lostpointercapture="handleShiftPointerEnd"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M5.5 3.5 10 8l-4.5 4.5"></path>
      </svg>
    </button>
    <button
      class="grid-adjust-icon-btn"
      type="button"
      :disabled="disabled"
      :title="t('mixtape.gridAdjustShiftRightLarge')"
      :aria-label="t('mixtape.gridAdjustShiftRightLarge')"
      @click="handleShiftClick('shift-right-large')"
      @pointerdown="handleShiftPointerDown('shift-right-large')"
      @pointerup="handleShiftPointerEnd"
      @pointercancel="handleShiftPointerEnd"
      @pointerleave="handleShiftPointerEnd"
      @lostpointercapture="handleShiftPointerEnd"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="m4.5 3.5 3.7 4.5-3.7 4.5"></path>
        <path d="m7.9 3.5 3.7 4.5-3.7 4.5"></path>
      </svg>
    </button>
    <input
      class="grid-adjust-bpm-input"
      type="number"
      inputmode="decimal"
      :step="bpmStep"
      :min="bpmMin"
      :max="bpmMax"
      :disabled="disabled"
      :value="bpmInputValue"
      :title="t('mixtape.bpm')"
      :aria-label="t('mixtape.bpm')"
      @input="handleBpmInput"
      @blur="emit('blur-bpm-input')"
      @keydown.enter.prevent="handleBpmInputEnter"
    />
    <button
      class="grid-adjust-tap-btn"
      type="button"
      :disabled="disabled"
      :title="t('mixtape.gridAdjustTapBpm')"
      :aria-label="t('mixtape.gridAdjustTapBpm')"
      @click="emit('tap-bpm')"
    >
      Tap
    </button>
  </div>
</template>

<style scoped lang="scss">
.grid-adjust-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.grid-adjust-icon-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.grid-adjust-icon-btn:focus,
.grid-adjust-tap-btn:focus {
  outline: none;
}

.grid-adjust-icon-btn:focus-visible,
.grid-adjust-tap-btn:focus-visible {
  outline: none;
  box-shadow: none;
}

.grid-adjust-icon-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.grid-adjust-icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.grid-adjust-icon-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grid-adjust-bpm-input {
  width: 62px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  line-height: 24px;
  text-align: center;
}

.grid-adjust-bpm-input:focus {
  border-color: var(--accent);
  outline: none;
}

.grid-adjust-bpm-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grid-adjust-tap-btn {
  height: 24px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  line-height: 22px;
  cursor: pointer;
}

.grid-adjust-tap-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.grid-adjust-tap-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
