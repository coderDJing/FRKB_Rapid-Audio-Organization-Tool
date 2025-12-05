<script setup lang="ts">
import { computed } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import type { IMetadataAutoFillSummary, IMetadataAutoFillItemResult } from 'src/types/globals'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{
  summary: IMetadataAutoFillSummary | null
}>()
const emits = defineEmits(['close'])
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const close = () => closeWithAnimation(() => emits('close'))

const scrollbarOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden', y: 'scroll' } as const
}

type SummaryChip = {
  label: string
  value: number | string
  danger?: boolean
}

const chips = computed((): SummaryChip[] => {
  const s = props.summary
  const stats: SummaryChip[] = [
    {
      label: t('metadata.autoFillStatTotal'),
      value: s?.total || 0
    },
    {
      label: t('metadata.autoFillStatApplied'),
      value: s?.applied || 0
    },
    {
      label: t('metadata.autoFillStatFingerprint'),
      value: s?.fingerprintApplied || 0
    },
    {
      label: t('metadata.autoFillStatSearch'),
      value: s?.searchApplied || 0
    },
    {
      label: t('metadata.autoFillStatNoMatch'),
      value: s?.noMatch || 0
    },
    {
      label: t('metadata.autoFillStatSkipped'),
      value: s?.skipped || 0
    },
    {
      label: t('metadata.autoFillStatErrors'),
      value: s?.errors || 0,
      danger: (s?.errors || 0) > 0
    }
  ]
  stats.push({
    label: t('metadata.autoFillSummaryDuration'),
    value: durationText.value
  })
  return stats
})

const durationText = computed(() => {
  const ms = props.summary?.durationMs || 0
  if (!ms) return '0s'
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
})

const hasItems = computed(() => {
  return (props.summary?.items?.length || 0) > 0
})

const statusClassMap: Record<IMetadataAutoFillItemResult['status'], string> = {
  applied: 'tag-good',
  'no-match': 'tag-neutral',
  skipped: 'tag-neutral',
  error: 'tag-warn'
}

const statusLabel = (status: IMetadataAutoFillItemResult['status']) => {
  if (status === 'applied') return t('metadata.autoFillStatus.applied')
  if (status === 'no-match') return t('metadata.autoFillStatus.noMatch')
  if (status === 'skipped') return t('metadata.autoFillStatus.skipped')
  return t('metadata.autoFillStatus.error')
}

const methodLabel = (method?: IMetadataAutoFillItemResult['method']) => {
  if (method === 'fingerprint') return t('metadata.autoFillMethod.fingerprint')
  if (method === 'search') return t('metadata.autoFillMethod.search')
  return t('metadata.autoFillMethod.unknown')
}

const reasonLabel = (item: IMetadataAutoFillItemResult) => {
  const code = item.messageCode || 'UNKNOWN'
  const key = `metadata.autoFillReason.${code}`
  const translated = t(key as any)
  if (item.messageDetail) {
    return `${translated} (${item.messageDetail})`
  }
  return translated
}

const shouldShowReason = (item: IMetadataAutoFillItemResult) => item.status === 'error'
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="dialog-title dialog-header">
        {{ t('metadata.autoFillSummaryTitle') }}
      </div>
      <div class="content">
        <div class="stats">
          <div class="section">
            <div class="section-title">{{ t('metadata.autoFillSummaryStatsTitle') }}</div>
            <div class="chips">
              <div
                class="chip"
                v-for="chip in chips"
                :key="chip.label"
                :class="{ danger: chip.danger }"
              >
                <div class="num">{{ chip.value }}</div>
                <div class="cap">{{ chip.label }}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="list-container">
          <div class="list-header">{{ t('metadata.autoFillSummaryListHeader') }}</div>
          <div class="list-wrapper" v-if="hasItems">
            <OverlayScrollbarsComponent
              class="list-scroll"
              :options="scrollbarOptions"
              element="div"
            >
              <div class="list">
                <div
                  class="item"
                  v-for="(item, index) in summary?.items"
                  :key="`${item.filePath}-${index}`"
                >
                  <div class="item-title">
                    <div class="name">{{ item.displayName || item.filePath }}</div>
                    <div class="tags">
                      <span class="tag" :class="statusClassMap[item.status]">
                        {{ statusLabel(item.status) }}
                      </span>
                      <span class="tag tag-muted" v-if="item.status === 'applied'">
                        {{ methodLabel(item.method) }}
                      </span>
                    </div>
                  </div>
                  <div class="item-desc" v-if="shouldShowReason(item)">
                    <span>{{ reasonLabel(item) }}</span>
                  </div>
                </div>
              </div>
            </OverlayScrollbarsComponent>
          </div>
          <div class="empty" v-else>
            {{ t('metadata.autoFillSummaryEmpty') }}
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="close">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 640px;
  max-height: 80vh;
  height: 80vh;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding: 20px;
}
.dialog-title {
  flex-shrink: 0;
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
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
  letter-spacing: 0.2px;
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
  text-align: center;
}
.chip .num {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}
.chip .cap {
  font-size: 11px;
  color: var(--text-weak, var(--text-secondary, #888));
  margin-top: 4px;
}
.chip.danger .num {
  color: #ff6b6b;
}
.list-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.list-header {
  padding: 10px 14px;
  font-size: 12px;
  color: var(--text-secondary, #888);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  font-weight: 600;
  flex-shrink: 0;
}
.list-wrapper {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  width: 100%;
}
.list-wrapper :deep(.os-host) {
  flex: 1;
  min-height: 0;
  height: 100%;
  width: 100%;
}
.list-wrapper :deep(.os-content) {
  min-height: 100%;
  width: 100% !important;
}

.list {
  min-width: 100%;
}
.item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.item:last-child {
  border-bottom: none;
}
.item-title {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.name {
  font-size: 13px;
  color: var(--text);
  font-weight: 600;
}
.tags {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
  justify-content: flex-end;
  align-items: center;
  flex-shrink: 0;
}
.tag {
  min-width: 72px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary, #666);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
}
.tag-good {
  border-color: var(--accent);
  color: var(--accent);
}
.tag-warn {
  border-color: #d13438;
  color: #d13438;
}
.tag-neutral {
  border-color: var(--border);
  color: var(--text-secondary, #666);
}
.tag-muted {
  border-color: var(--border);
  color: var(--text-secondary, #999);
}
.item-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary, #888);
  user-select: text;
  -webkit-user-select: text;
  word-break: break-word;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-secondary, #888);
  padding: 20px;
  text-align: center;
}
</style>
