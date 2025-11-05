<script setup lang="ts">
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  summary: {
    total: number
    success: number
    failed: number
    skipped: number
    overwritten: number
    renamed: number
    backupCount: number
    fingerprintAddedCount: number
    durationMs?: number
  } | null
}>()
const emits = defineEmits(['close'])

const formatDurationSec = (ms?: number) => {
  const s = (ms || 0) / 1000
  if (s >= 10) return String(Math.round(s))
  return String(Math.round(s * 10) / 10)
}
</script>

<template>
  <div class="dialog unselectable">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="title dialog-title">{{ t('convert.completed') }}</div>
      <div class="stats">
        <div class="section">
          <div class="section-title">{{ t('import.overview') }}</div>
          <div class="chips">
            <div class="chip">
              <div class="num">{{ summary?.success || 0 }}</div>
              <div class="cap">{{ t('convert.converted') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ summary?.skipped || 0 }}</div>
              <div class="cap">{{ t('convert.skippedSameFormat') }}</div>
            </div>
            <div class="chip" :class="{ danger: (summary?.failed || 0) > 0 }">
              <div class="num">{{ summary?.failed || 0 }}</div>
              <div class="cap">{{ t('convert.failed') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ formatDurationSec(summary?.durationMs) }}</div>
              <div class="cap">{{ t('cloudSync.duration') }} ({{ t('player.seconds') }})</div>
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">{{ t('import.overview') }}</div>
          <div class="chips">
            <div class="chip">
              <div class="num">{{ summary?.renamed || 0 }}</div>
              <div class="cap">{{ t('convert.createdNew') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ summary?.overwritten || 0 }}</div>
              <div class="cap">{{ t('convert.replaced') }}</div>
            </div>
            <div class="chip" :class="{ success: (summary?.fingerprintAddedCount || 0) > 0 }">
              <div class="num">{{ summary?.fingerprintAddedCount || 0 }}</div>
              <div class="cap">{{ t('import.newFingerprints') }}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="actions">
        <div class="button" @click="$emit('close')">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.title {
  text-align: center;
  font-weight: bold;
  color: var(--text);
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  color: var(--text);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  color: var(--text);
  font-weight: 700;
}
.chips {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.chip {
  min-width: 96px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}
.chip .num {
  font-size: 18px;
  color: var(--text);
  font-weight: 700;
  line-height: 1;
}
.chip .cap {
  font-size: 11px;
  color: var(--text-weak);
  margin-top: 4px;
}
.chip.danger .num {
  color: #ff6b6b;
}
.chip.success .num {
  color: #9fe870;
}
.actions {
  display: flex;
  justify-content: center;
  padding-top: 10px;
}
</style>
