<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  visible: boolean
  title: string
  text: string
  percent: number
  hint: string
}>()

const clampedPercent = computed(() => Math.max(0, Math.min(100, Math.round(props.percent || 0))))
</script>

<template>
  <div v-if="visible" class="analysis-runtime-download-mask">
    <div class="analysis-runtime-download-card">
      <div class="analysis-runtime-download-title">{{ title }}</div>
      <div class="analysis-runtime-download-hint">{{ hint }}</div>
      <div class="analysis-runtime-download-text">{{ text }}</div>
      <div class="analysis-runtime-download-progress-row">
        <span>{{ clampedPercent }}%</span>
      </div>
      <div class="analysis-runtime-download-progress">
        <div
          class="analysis-runtime-download-progress__fill"
          :style="{ width: `${clampedPercent}%` }"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.analysis-runtime-download-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(10px);
  cursor: progress;
}

.analysis-runtime-download-card {
  width: min(480px, 100%);
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.analysis-runtime-download-title {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
}

.analysis-runtime-download-hint,
.analysis-runtime-download-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-weak);
  overflow-wrap: anywhere;
}

.analysis-runtime-download-progress-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  font-size: 12px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.analysis-runtime-download-progress {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.18);
}

.analysis-runtime-download-progress__fill {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, var(--accent), rgba(54, 156, 255, 0.72));
  transition: width 0.2s ease;
}
</style>
