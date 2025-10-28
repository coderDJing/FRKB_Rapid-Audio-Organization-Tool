<script setup lang="ts">
import { computed } from 'vue'

interface Option {
  label: string
  value: string
}
const props = defineProps<{
  modelValue: string
  name?: string
  options: Option[]
  disabled?: boolean
  optionFontSize?: string | number
}>()
const emits = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'change', v: string): void
}>()

const current = computed({
  get: () => props.modelValue,
  set: (v: string) => {
    emits('update:modelValue', v)
    emits('change', v)
  }
})

const optionFontSizeVar = computed(() => {
  const v = props.optionFontSize
  if (v === undefined || v === null) return '14px'
  return typeof v === 'number' ? `${v}px` : String(v)
})
</script>

<template>
  <div
    class="radio-group"
    :aria-disabled="!!disabled"
    :style="{ '--radio-option-font-size': optionFontSizeVar } as any"
  >
    <label v-for="opt in options" :key="opt.value" class="radio">
      <input
        type="radio"
        :name="name || 'single-radio-group'"
        :value="opt.value"
        v-model="current as any"
        :disabled="disabled"
      />
      <span class="dot"></span>
      <slot name="option" :opt="opt">
        <span class="label">{{ opt.label }}</span>
      </slot>
    </label>
  </div>
</template>

<style lang="scss" scoped>
.radio-group {
  display: flex;
  flex-direction: column; /* 强制竖排 */
  gap: 10px;
  color: var(--text);
}
.radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: default; /* 不显示小手 */
  user-select: none;
  font-size: var(--radio-option-font-size, 14px);
  padding: 2px 6px;
  border-radius: 4px;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.radio input[type='radio'] {
  appearance: none;
  -webkit-appearance: none;
  width: 0;
  height: 0;
  position: absolute;
}
.radio .dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: transparent;
  position: relative;
  transition: all 0.15s ease;
}
.radio .dot::after {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.12s ease;
}
.radio input[type='radio']:checked + .dot::after {
  opacity: 1;
}
.radio input[type='radio']:checked + .dot {
  border-color: var(--accent);
}
.radio:hover .dot {
  border-color: var(--accent);
}
.radio:hover .label {
  color: var(--accent);
}
.radio .label {
  line-height: 16px;
}
.radio-group[aria-disabled='true'] {
  opacity: 0.5;
  pointer-events: none;
}
</style>
