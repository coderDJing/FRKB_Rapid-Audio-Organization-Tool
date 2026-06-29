<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '@renderer/i18n'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import { collectMissingAnalysisFilesFromSongs } from '@renderer/utils/manualKeyAnalysis'
import type { ISongInfo } from 'src/types/globals'

const runtime = useRuntimeStore()

const normalizeAnalysisPath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const isPioneerView = computed(() => runtime.libraryAreaSelected === 'PioneerDeviceLibrary')
const currentLocale = computed(() => i18n.global.locale.value)
const totalDurationLabel = computed(() => t('bottomInfo.totalDurationLabel'))
const selectedSongCount = computed(() =>
  isPioneerView.value
    ? runtime.pioneerSelectedRowKeys.filter(Boolean).length
    : runtime.songsArea.selectedSongFilePath.filter(Boolean).length
)
const selectedSongsText = computed(() =>
  t('bottomInfo.selectedSongs', { count: selectedSongCount.value })
)

const collectPendingAnalysisFiles = (songInfoArr: ISongInfo[]): string[] =>
  collectMissingAnalysisFilesFromSongs(songInfoArr, runtime.analysisRuntime.available === true)

const pendingAnalysisFiles = computed(() =>
  collectPendingAnalysisFiles(runtime.songsArea?.songInfoArr || [])
)
const pendingAnalysisCount = computed(() =>
  isPioneerView.value ? 0 : pendingAnalysisFiles.value.length
)
const manualPendingAnalysisCount = computed(
  () =>
    new Set(
      runtime.manualKeyAnalysisPendingFilePaths
        .map((filePath) => normalizeAnalysisPath(filePath))
        .filter(Boolean)
    ).size
)
const pioneerPendingAnalysisCount = computed(() =>
  Math.max(0, Number(runtime.pioneerDeviceLibrary.pendingAnalysisCount) || 0)
)
const splitLeftPendingFiles = computed(() =>
  collectPendingAnalysisFiles(runtime.songsAreaPanels.panes.left.songInfoArr)
)
const splitRightPendingFiles = computed(() =>
  collectPendingAnalysisFiles(runtime.songsAreaPanels.panes.right.songInfoArr)
)
const splitLeftPendingCount = computed(() => splitLeftPendingFiles.value.length)
const splitRightPendingCount = computed(() => splitRightPendingFiles.value.length)
const displayPendingAnalysisCount = computed(() =>
  manualPendingAnalysisCount.value > 0
    ? manualPendingAnalysisCount.value
    : pendingAnalysisCount.value
)
const displayPioneerPendingAnalysisCount = computed(() =>
  manualPendingAnalysisCount.value > 0
    ? manualPendingAnalysisCount.value
    : pioneerPendingAnalysisCount.value
)
const hasTotalRowContent = computed(() => {
  if (manualPendingAnalysisCount.value > 0) return true
  if (isPioneerView.value) {
    return selectedSongCount.value > 0 || pioneerPendingAnalysisCount.value > 0
  }
  if (runtime.songsAreaPanels.splitEnabled) {
    return (
      runtime.songsAreaPanels.panes.left.songInfoArr.length > 0 ||
      runtime.songsAreaPanels.panes.right.songInfoArr.length > 0
    )
  }
  return Boolean(runtime.songsArea.songListUUID && runtime.songsArea.songInfoArr.length > 0)
})
function formatDurationUnit(unit: 'day' | 'hour' | 'minute' | 'second', count: number): string {
  const pluralKey = count === 1 ? 'one' : 'other'
  return t(`bottomInfo.durationUnits.${unit}.${pluralKey}`, { count })
}

const playlistTotalDaysHoursSeconds = computed(() => {
  const list = (runtime.songsArea?.songInfoArr || []) as Array<{ duration?: string }>
  let total = 0
  for (const s of list) {
    const mmss = String(s?.duration || '')
    const parts = mmss.split(':')
    if (parts.length === 2) {
      const m = Number(parts[0])
      const sec = Number(parts[1])
      if (!Number.isNaN(m) && !Number.isNaN(sec)) {
        total += m * 60 + sec
      }
    }
  }
  const days = Math.floor(total / 86400)
  const afterDays = total % 86400
  const hours = Math.floor(afterDays / 3600)
  const afterHours = afterDays % 3600
  const minutes = Math.floor(afterHours / 60)
  const seconds = afterHours % 60
  const joiner = currentLocale.value === 'zh-CN' ? '' : ' '
  const segments: string[] = []
  if (days > 0) {
    segments.push(formatDurationUnit('day', days))
  }
  segments.push(formatDurationUnit('hour', hours))
  segments.push(formatDurationUnit('minute', minutes))
  segments.push(formatDurationUnit('second', seconds))
  return segments.join(joiner)
})
</script>

<template>
  <div v-if="hasTotalRowContent" class="total-row">
    <div v-if="selectedSongCount > 0" class="selected-count-text">{{ selectedSongsText }}</div>
    <template
      v-if="
        !isPioneerView && runtime.songsAreaPanels.splitEnabled && manualPendingAnalysisCount <= 0
      "
    >
      <div v-if="splitLeftPendingCount > 0" class="selected-count-text">
        {{ t('bottomInfo.pendingAnalysisLeft', { count: splitLeftPendingCount }) }}
      </div>
      <div v-if="splitRightPendingCount > 0" class="selected-count-text">
        {{ t('bottomInfo.pendingAnalysisRight', { count: splitRightPendingCount }) }}
      </div>
    </template>
    <template v-else-if="isPioneerView">
      <div v-if="displayPioneerPendingAnalysisCount > 0" class="selected-count-text">
        {{ t('bottomInfo.pendingAnalysis', { count: displayPioneerPendingAnalysisCount }) }}
      </div>
    </template>
    <template v-else>
      <div v-if="displayPendingAnalysisCount > 0" class="selected-count-text">
        {{ t('bottomInfo.pendingAnalysis', { count: displayPendingAnalysisCount }) }}
      </div>
    </template>
    <div v-if="!isPioneerView" class="total-text">
      {{ totalDurationLabel }}{{ playlistTotalDaysHoursSeconds }}
    </div>
  </div>
</template>
<style lang="scss" scoped src="./BottomInfoAreaTotalRow.scss"></style>
