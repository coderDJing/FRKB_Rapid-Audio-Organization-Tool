<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'

type LibraryMergePhase =
  | 'preflight'
  | 'staging'
  | 'promoting'
  | 'committing'
  | 'deleting-source'
  | 'completed'
  | 'failed'

type LibraryMergeProgress = {
  phase: LibraryMergePhase
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  currentPath?: string
}

const props = defineProps<{
  progress: LibraryMergeProgress | null
}>()

const currentPathRef = useTemplateRef<HTMLElement>('currentPathRef')
const phaseTitleKey = computed(() => {
  const phase = props.progress?.phase || 'preflight'
  return `migration.mergePhase.${phase}`
})
const phaseDescriptionKey = computed(() => {
  const phase = props.progress?.phase || 'preflight'
  return `migration.mergeDescription.${phase}`
})
const hasKnownByteTotal = computed(() => Number(props.progress?.totalBytes || 0) > 0)
const progressPercent = computed(() => {
  if (!hasKnownByteTotal.value) return null
  const value =
    (Number(props.progress?.copiedBytes || 0) / Number(props.progress?.totalBytes || 1)) * 100
  return Math.max(0, Math.min(100, value))
})
const progressPercentText = computed(() =>
  progressPercent.value === null ? '' : `${Math.round(progressPercent.value)}%`
)
const currentPath = computed(() => String(props.progress?.currentPath || '').trim())

const formatBytes = (value: number) => {
  const bytes = Math.max(0, Number(value) || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let result = bytes
  while (result >= 1024 && index < units.length - 1) {
    result /= 1024
    index += 1
  }
  const precision = index === 0 || result >= 100 ? 0 : 1
  return `${result.toFixed(precision)} ${units[index]}`
}
</script>

<template>
  <div v-if="progress" class="library-merge-mask" role="alertdialog" aria-modal="true">
    <section class="library-merge-card" aria-live="polite">
      <div class="library-merge-title">{{ t(phaseTitleKey) }}</div>
      <div class="library-merge-description">{{ t(phaseDescriptionKey) }}</div>
      <div
        class="library-merge-progress-track"
        :class="{ indeterminate: progressPercent === null }"
      >
        <div
          v-if="progressPercent !== null"
          class="library-merge-progress-fill"
          :style="{ width: `${progressPercent}%` }"
        ></div>
      </div>
      <div class="library-merge-progress-stats">
        <span v-if="hasKnownByteTotal">
          {{ formatBytes(progress.copiedBytes) }} / {{ formatBytes(progress.totalBytes) }}
        </span>
        <span v-else>{{ t('migration.mergePreparing') }}</span>
        <span v-if="progressPercent !== null">{{ progressPercentText }}</span>
      </div>
      <div class="library-merge-file-stats">
        {{ progress.copiedFiles }} / {{ progress.totalFiles }} {{ t('migration.mergeFiles') }}
      </div>
      <div v-if="currentPath" ref="currentPathRef" class="library-merge-current-path">
        {{ currentPath }}
      </div>
      <bubbleBox
        v-if="currentPath"
        :dom="currentPathRef || undefined"
        :title="currentPath"
        :max-width="620"
      />
      <div class="library-merge-lock-hint">{{ t('migration.mergeLockedHint') }}</div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.library-merge-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--text) 30%, transparent);
  backdrop-filter: blur(10px);
  cursor: progress;
}

.library-merge-card {
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-elev);
  color: var(--text);
  box-shadow: 0 24px 60px color-mix(in srgb, var(--text) 26%, transparent);
}

.library-merge-title {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.45;
}

.library-merge-description,
.library-merge-file-stats,
.library-merge-lock-hint {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-weak);
}

.library-merge-progress-track {
  position: relative;
  width: 100%;
  height: 9px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border) 70%, transparent);
}

.library-merge-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 68%, var(--bg-elev))
  );
  transition: width 0.2s ease;
}

.library-merge-progress-track.indeterminate::before {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 36%;
  border-radius: inherit;
  background: var(--accent);
  content: '';
  animation: library-merge-indeterminate 1.25s ease-in-out infinite;
}

.library-merge-progress-stats {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.library-merge-current-path {
  overflow: hidden;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-merge-lock-hint {
  margin-top: 2px;
}

@keyframes library-merge-indeterminate {
  0% {
    transform: translateX(-130%);
  }
  100% {
    transform: translateX(340%);
  }
}
</style>
