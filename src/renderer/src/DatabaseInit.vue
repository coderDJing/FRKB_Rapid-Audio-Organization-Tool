<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { formatWindowTitle } from '@renderer/utils/windowTitle'

type SchemaMigrationPhase =
  | 'checking-version'
  | 'checking-space'
  | 'creating-backup'
  | 'converting'
  | 'restoring-time-basis'
  | 'validating'
  | 'complete'
  | 'failed'
type SchemaMigrationProgress = {
  phase: SchemaMigrationPhase
  databasePath: string
  backupPath?: string
  message?: string
  processedRows?: number
  totalRows?: number
  processedPages?: number
  totalPages?: number
}

const isSchemaMigrationMode =
  new URLSearchParams(window.location.search).get('mode') === 'schema-migration'
const schemaMigrationProgress = ref<SchemaMigrationProgress | null>(null)
const databaseInitWindowTitle = computed(() =>
  formatWindowTitle(
    isSchemaMigrationMode ? t('database.schemaMigrationTitle') : t('database.selectLocation')
  )
)
const schemaMigrationStatus = computed(() => {
  switch (schemaMigrationProgress.value?.phase) {
    case 'checking-version':
      return t('database.schemaMigrationCheckingVersion')
    case 'checking-space':
      return t('database.schemaMigrationCheckingSpace')
    case 'creating-backup':
      return t('database.schemaMigrationCreatingBackup')
    case 'converting':
      return t('database.schemaMigrationConverting')
    case 'restoring-time-basis':
      return t('database.schemaMigrationRestoringTimeBasis')
    case 'validating':
      return t('database.schemaMigrationValidating')
    case 'complete':
      return t('database.schemaMigrationComplete')
    case 'failed':
      return t('database.schemaMigrationFailed')
    default:
      return ''
  }
})
const schemaMigrationPercent = computed(() => {
  const progress = schemaMigrationProgress.value
  if (!progress) return 0
  if (progress.phase === 'checking-version') return 3
  if (progress.phase === 'checking-space') return 8
  if (progress.phase === 'creating-backup') {
    const totalPages = Number(progress.totalPages)
    const processedPages = Number(progress.processedPages)
    if (Number.isFinite(totalPages) && totalPages > 0 && Number.isFinite(processedPages)) {
      return Math.round(10 + Math.min(1, Math.max(0, processedPages / totalPages)) * 60)
    }
    return 10
  }
  if (progress.phase === 'converting' || progress.phase === 'restoring-time-basis') {
    const totalRows = Number(progress.totalRows)
    const processedRows = Number(progress.processedRows)
    if (Number.isFinite(totalRows) && totalRows > 0 && Number.isFinite(processedRows)) {
      return Math.round(70 + Math.min(1, Math.max(0, processedRows / totalRows)) * 24)
    }
    return 70
  }
  if (progress.phase === 'validating') return 97
  if (progress.phase === 'complete') return 100
  return 0
})
const schemaMigrationUnitProgress = computed(() => {
  const progress = schemaMigrationProgress.value
  const totalPages = Number(progress?.totalPages)
  const processedPages = Number(progress?.processedPages)
  if (progress?.phase === 'creating-backup' && Number.isFinite(totalPages) && totalPages > 0) {
    return t('database.schemaMigrationBackupProgress', {
      processedPages: Math.min(
        Math.max(0, Math.floor(processedPages) || 0),
        Math.floor(totalPages)
      ),
      totalPages: Math.floor(totalPages)
    })
  }
  const totalRows = Number(progress?.totalRows)
  const processedRows = Number(progress?.processedRows)
  if (
    (progress?.phase !== 'converting' && progress?.phase !== 'restoring-time-basis') ||
    !Number.isFinite(totalRows) ||
    totalRows <= 0
  )
    return ''
  return t('database.schemaMigrationRecordProgress', {
    processedRows: Math.min(Math.max(0, Math.floor(processedRows) || 0), Math.floor(totalRows)),
    totalRows: Math.floor(totalRows)
  })
})

watch(
  databaseInitWindowTitle,
  (title) => {
    document.title = title
  },
  { immediate: true }
)

const closeSchemaMigrationWindow = () => {
  if (!isSchemaMigrationMode || schemaMigrationProgress.value?.phase !== 'failed') return
  window.electron.ipcRenderer.send('databaseSchemaMigrationWindow-close')
}

window.electron.ipcRenderer.on('databaseInitWindow-schemaMigrationProgress', (_event, payload) => {
  if (!payload || typeof payload !== 'object') {
    schemaMigrationProgress.value = null
    return
  }
  schemaMigrationProgress.value = payload as SchemaMigrationProgress
})
</script>

<template>
  <div
    style="
      height: 100%;
      max-height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    "
    class="unselectable"
  >
    <div class="schema-migration-card schema-migration-card-standalone">
      <div class="schema-migration-title canDrag">{{ t('database.schemaMigrationTitle') }}</div>
      <div class="schema-migration-status">{{ schemaMigrationStatus }}</div>
      <div
        class="schema-migration-progress"
        role="progressbar"
        :aria-valuenow="schemaMigrationPercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div
          class="schema-migration-progress-fill"
          :style="{ width: `${schemaMigrationPercent}%` }"
        />
      </div>
      <div class="schema-migration-percent">{{ schemaMigrationPercent }}%</div>
      <div v-if="schemaMigrationUnitProgress" class="schema-migration-record-progress">
        {{ schemaMigrationUnitProgress }}
      </div>
      <div v-if="schemaMigrationProgress" class="schema-migration-path">
        {{ schemaMigrationProgress.databasePath }}
      </div>
      <div v-if="schemaMigrationProgress?.phase === 'failed'" class="schema-migration-error">
        <div>{{ t('database.schemaMigrationFailedHint') }}</div>
        <div v-if="schemaMigrationProgress.backupPath">
          {{ t('database.schemaMigrationBackupRetained') }}
          {{ schemaMigrationProgress.backupPath }}
        </div>
        <div v-if="schemaMigrationProgress.message">{{ schemaMigrationProgress.message }}</div>
        <div style="display: flex; justify-content: center; margin-top: 14px">
          <div
            class="button"
            style="width: 120px; text-align: center"
            @click="closeSchemaMigrationWindow()"
          >
            {{ t('common.close') }}
          </div>
        </div>
      </div>
      <div v-else class="schema-migration-hint">
        {{ t('database.schemaMigrationBlockingHint') }}
      </div>
    </div>
  </div>
</template>
<style lang="scss">
#app {
  color: var(--text);
  background-color: var(--bg);
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: var(--bg-elev);
}

.schema-migration-card {
  width: min(460px, 100%);
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
  box-shadow: 0 12px 30px color-mix(in srgb, #000 35%, transparent);
}

.schema-migration-card-standalone {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.schema-migration-title {
  font-size: 16px;
  font-weight: 600;
}

.schema-migration-status {
  margin-top: 12px;
  color: var(--accent);
}

.schema-migration-progress {
  height: 8px;
  margin-top: 14px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.schema-migration-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 180ms ease-out;
}

.schema-migration-percent,
.schema-migration-record-progress {
  margin-top: 6px;
  color: var(--text-weak);
  font-size: 12px;
}

.schema-migration-path,
.schema-migration-error,
.schema-migration-hint {
  margin-top: 10px;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.schema-migration-error {
  color: var(--danger, #dc3545);
}
</style>
