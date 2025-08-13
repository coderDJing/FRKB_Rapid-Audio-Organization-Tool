<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  summary: {
    startAt: string
    endAt: string
    durationMs: number
    scannedCount: number
    analyzeFailedCount: number
    importedToPlaylistCount: number
    duplicatesRemovedCount: number
    fingerprintAddedCount: number
    fingerprintAlreadyExistingCount: number
    fingerprintTotalBefore: number
    fingerprintTotalAfter: number
    isComparisonSongFingerprint: boolean
    isPushSongFingerprintLibrary: boolean
  } | null
}>()
const emits = defineEmits(['close'])

const formatDurationSec = (ms: number) => {
  const seconds = ms / 1000
  if (seconds >= 10) return String(Math.round(seconds))
  return String(Math.round(seconds * 10) / 10)
}

const hasFingerprintSection = computed(() => {
  return !!props.summary && props.summary.isPushSongFingerprintLibrary === true
})
</script>

<template>
  <div class="dialog unselectable">
    <div class="inner">
      <div class="title">{{ t('导入完成') }}</div>
      <div class="stats">
        <div class="section">
          <div class="section-title">{{ t('结果概览') }}</div>
          <div class="chips">
            <div class="chip">
              <div class="num">{{ summary?.importedToPlaylistCount || 0 }}</div>
              <div class="cap">{{ t('导入到歌单') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ summary?.duplicatesRemovedCount || 0 }}</div>
              <div class="cap">{{ t('去重删除/跳过') }}</div>
            </div>
            <div class="chip" :class="{ danger: (summary?.analyzeFailedCount || 0) > 0 }">
              <div class="num">{{ summary?.analyzeFailedCount || 0 }}</div>
              <div class="cap">{{ t('分析失败') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ formatDurationSec(summary?.durationMs || 0) }}</div>
              <div class="cap">{{ t('耗时') }} ({{ t('秒') }})</div>
            </div>
          </div>
        </div>
        <div class="section" v-if="hasFingerprintSection">
          <div class="section-title">{{ t('指纹库变化') }}</div>
          <div class="chips">
            <div class="chip" :class="{ success: (summary?.fingerprintAddedCount || 0) > 0 }">
              <div class="num">{{ summary?.fingerprintAddedCount || 0 }}</div>
              <div class="cap">{{ t('指纹新增') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ summary?.fingerprintAlreadyExistingCount || 0 }}</div>
              <div class="cap">{{ t('已存在') }}</div>
            </div>
          </div>
        </div>
        <div class="section" v-if="hasFingerprintSection">
          <div class="section-title">{{ t('现有指纹总量') }}</div>
          <div class="section-body">
            <span class="count-pair">
              <span class="count-text">{{ summary?.fingerprintTotalBefore || 0 }}</span>
              <span class="arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M5 12h12M13 6l6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></path>
                </svg>
              </span>
              <span class="count-text">{{ summary?.fingerprintTotalAfter || 0 }}</span>
            </span>
          </div>
        </div>
      </div>
      <div class="actions">
        <div class="button" @click="$emit('close')">{{ t('关闭') }}</div>
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
  color: #e5e5e5;
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  color: #d0d0d0;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  color: #d0d0d0;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.section-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row .label {
  width: 90px;
  min-width: 90px;
  text-align: right;
  color: #bdbdbd;
}
.row .value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.chips {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.chip {
  min-width: 96px;
  padding: 8px 10px;
  border: 1px solid #2c2c2c;
  border-radius: 6px;
  background: #202020;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}
.chip .num {
  font-size: 18px;
  color: #e5e5e5;
  font-weight: 700;
  line-height: 1;
}
.chip .cap {
  font-size: 11px;
  color: #a8a8a8;
  margin-top: 4px;
}
.chip.danger .num {
  color: #ff6b6b;
}
.chip.success .num {
  color: #9fe870;
}
.big {
  font-size: 14px;
  color: #e5e5e5;
  font-weight: 600;
}
.muted {
  color: #a8a8a8;
}
.count-pair {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
}
.count-pair > .count-text {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
}
.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin: 0 6px;
  line-height: 14px;
  vertical-align: middle;
}
.arrow svg {
  width: 14px;
  height: 14px;
  display: block;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 0;
  padding-top: 10px;
}
</style>
