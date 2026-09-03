<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import confirm from '@renderer/components/confirmDialog'
import curatedLibrarySyncJoinDialog from '@renderer/components/curatedLibrarySyncJoinDialog'
import { t } from '@renderer/utils/translate'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'
import {
  settingDialogContextKey,
  type SettingDialogContext
} from '@renderer/components/settingDialog/context'
import type {
  CuratedLibrarySyncConflictItem,
  CuratedLibrarySyncConflictKind,
  CuratedLibrarySyncFailureItem,
  CuratedLibrarySyncOverview,
  CuratedLibrarySyncStartResult
} from '../../../../shared/curatedLibrarySync'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) {
  throw new Error('settingDialogContext is missing')
}

const { runtime, setSetting } = ctx

const CONFLICT_KIND_KEYS: Record<CuratedLibrarySyncConflictKind, string> = {
  'file-move-lost': 'cloudSync.curatedLibrary.conflictKinds.fileMoveLost',
  'file-rename-lost': 'cloudSync.curatedLibrary.conflictKinds.fileRenameLost',
  'file-content-lost': 'cloudSync.curatedLibrary.conflictKinds.fileContentLost',
  'file-delete-lost': 'cloudSync.curatedLibrary.conflictKinds.fileDeleteLost',
  'file-undelete-lost': 'cloudSync.curatedLibrary.conflictKinds.fileUndeleteLost',
  'file-order-lost': 'cloudSync.curatedLibrary.conflictKinds.fileOrderLost',
  'node-change-lost': 'cloudSync.curatedLibrary.conflictKinds.nodeChangeLost',
  'node-delete-lost': 'cloudSync.curatedLibrary.conflictKinds.nodeDeleteLost'
}

const emptyOverview = (): CuratedLibrarySyncOverview => ({
  liveConnected: false,
  snapshotReady: false,
  revision: 0,
  fileCount: 0,
  quotaUsedBytes: 0,
  quotaBytes: 0,
  conflicts: [],
  failures: []
})

const overview = ref<CuratedLibrarySyncOverview>(emptyOverview())
const syncing = ref(false)
const MAX_VISIBLE_FAILURES = 8
let liveTimer: ReturnType<typeof setInterval> | null = null

const enabledModel = computed<boolean>({
  get: () => runtime.setting.curatedLibrarySyncEnabled === true,
  set: (value) => {
    runtime.setting.curatedLibrarySyncEnabled = value === true
  }
})

const quotaPercent = computed(() => {
  const limit = overview.value.quotaBytes
  if (limit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((overview.value.quotaUsedBytes / limit) * 100)))
})

const quotaNearFull = computed(() => overview.value.quotaBytes > 0 && quotaPercent.value >= 90)

const visibleFailures = computed(() => overview.value.failures.slice(0, MAX_VISIBLE_FAILURES))

const extraFailureCount = computed(() =>
  Math.max(0, overview.value.failures.length - visibleFailures.value.length)
)

const refreshOverview = async () => {
  try {
    const next = (await window.electron.ipcRenderer.invoke(
      'curatedLibrarySync/getOverview'
    )) as CuratedLibrarySyncOverview
    overview.value = next
  } catch {
    overview.value = {
      ...emptyOverview(),
      conflicts: overview.value.conflicts,
      failures: overview.value.failures
    }
  }
}

const handleEnabledChange = async () => {
  await setSetting()
  window.setTimeout(() => {
    void refreshOverview()
  }, 400)
}

const startCuratedLibrarySync = async (
  extra?: { joinMode?: 'merge' | 'cloud-wins' | 'local-wins'; confirmOverwriteCloud?: boolean },
  isContinue = false
) => {
  if (!isContinue && (syncing.value || !enabledModel.value)) return
  if (!isContinue) syncing.value = true
  try {
    const result = (await window.electron.ipcRenderer.invoke('curatedLibrarySync/start', {
      trigger: 'manual',
      ...extra
    })) as CuratedLibrarySyncStartResult
    if (result.status === 'needs_join_choice') {
      const choice = await curatedLibrarySyncJoinDialog({
        title: t('cloudSync.curatedLibrary.joinTitle'),
        lines: [
          t('cloudSync.curatedLibrary.joinIntro'),
          t('cloudSync.curatedLibrary.joinCounts', {
            local: result.localFileCount,
            cloud: result.cloudFileCount
          }),
          t('cloudSync.curatedLibrary.joinMergeHint'),
          t('cloudSync.curatedLibrary.joinCloudHint'),
          t('cloudSync.curatedLibrary.joinLocalHint')
        ],
        mergeLabel: t('cloudSync.curatedLibrary.joinMerge'),
        cloudWinsLabel: t('cloudSync.curatedLibrary.joinCloud'),
        localWinsLabel: t('cloudSync.curatedLibrary.joinLocal'),
        cancelLabel: t('common.cancel')
      })
      if (choice === 'cancel') return
      await startCuratedLibrarySync({ joinMode: choice }, true)
      return
    }
    if (result.status === 'needs_overwrite_cloud_confirm') {
      const confirmed = await confirm({
        title: t('cloudSync.curatedLibrary.overwriteTitle'),
        content: [
          t('cloudSync.curatedLibrary.overwriteWarning', {
            local: result.localFileCount,
            cloud: result.cloudFileCount
          }),
          t('cloudSync.curatedLibrary.overwriteConfirmHint')
        ],
        confirmText: t('cloudSync.curatedLibrary.overwriteConfirm'),
        cancelText: t('common.cancel'),
        innerHeight: 260
      })
      if (confirmed !== 'confirm') return
      await startCuratedLibrarySync({ joinMode: 'local-wins', confirmOverwriteCloud: true }, true)
      return
    }
    if (result.status === 'success' || result.status === 'already_running') {
      await refreshOverview()
      return
    }
    if (result.status === 'cancelled') {
      await refreshOverview()
      return
    }
    const messageKey =
      result.status === 'failed'
        ? result.message
        : result.status === 'not_enabled'
          ? 'cloudSync.curatedLibrary.errors.notEnabled'
          : result.status === 'not_configured'
            ? 'cloudSync.notConfigured'
            : result.status === 'busy_library'
              ? 'cloudSync.curatedLibrary.errors.busyLibrary'
              : result.status === 'disk_full'
                ? 'cloudSync.curatedLibrary.errors.diskFull'
                : result.status === 'paused_offline'
                  ? 'cloudSync.errors.cannotConnect'
                  : 'cloudSync.curatedLibrary.errors.failed'
    await confirm({
      title: t('common.error'),
      content: [t(messageKey)],
      confirmShow: false
    })
    await refreshOverview()
  } finally {
    syncing.value = false
  }
}

const conflictLine = (item: CuratedLibrarySyncConflictItem) => {
  const kind = t(CONFLICT_KIND_KEYS[item.kind])
  if (item.otherName) {
    return t('cloudSync.curatedLibrary.conflictLineNamed', {
      kind,
      name: item.name,
      otherName: item.otherName
    })
  }
  return t('cloudSync.curatedLibrary.conflictLine', { kind, name: item.name })
}

const showConflicts = async () => {
  const items = overview.value.conflicts
  if (items.length === 0) return
  await confirm({
    title: t('cloudSync.curatedLibrary.conflictsTitle'),
    content: items.map((item) => conflictLine(item)),
    confirmShow: false,
    innerHeight: 320
  })
}

const clearConflicts = async () => {
  await window.electron.ipcRenderer.invoke('curatedLibrarySync/clearConflicts')
  await refreshOverview()
}

const clearFailures = async () => {
  await window.electron.ipcRenderer.invoke('curatedLibrarySync/clearFailures')
  await refreshOverview()
}

const retryFailures = async () => {
  await startCuratedLibrarySync()
}

const failureText = (item: CuratedLibrarySyncFailureItem) => {
  const direction =
    item.direction === 'upload'
      ? t('cloudSync.curatedLibrary.uploadFailed')
      : t('cloudSync.curatedLibrary.downloadFailed')
  return `${direction} · ${t(item.errorKey)}`
}

const handleNotice = () => {
  void refreshOverview()
}

const refreshLiveConnected = async () => {
  try {
    const live = await window.electron.ipcRenderer.invoke('curatedLibrarySync/isLiveConnected')
    overview.value = {
      ...overview.value,
      liveConnected: live === true
    }
  } catch {
    overview.value = { ...overview.value, liveConnected: false }
  }
}

onMounted(() => {
  window.electron.ipcRenderer.on('curatedLibrarySync/notice', handleNotice)
  void refreshOverview()
  liveTimer = setInterval(() => {
    void refreshLiveConnected()
  }, 2000)
})

onBeforeUnmount(() => {
  window.electron.ipcRenderer.removeListener('curatedLibrarySync/notice', handleNotice)
  if (liveTimer != null) {
    clearInterval(liveTimer)
    liveTimer = null
  }
})
</script>

<template>
  <label class="setting-block" for="setting-checkbox-curatedLibrarySync">
    {{ t('cloudSync.curatedLibrary.enabled') }}：
  </label>
  <div class="setting-control">
    <singleCheckbox
      id="setting-checkbox-curatedLibrarySync"
      v-model="enabledModel"
      @change="handleEnabledChange()"
    />
    <div class="setting-hint">{{ t('cloudSync.curatedLibrary.enabledHint') }}</div>
    <div class="setting-hint">{{ t('cloudSync.curatedLibrary.scopeHint') }}</div>
    <div class="buttonRow">
      <bubbleBoxTrigger
        tag="div"
        class="button-anchor"
        :title="enabledModel ? '' : t('cloudSync.curatedLibrary.errors.notEnabled')"
      >
        <div
          class="button settings-inline-button"
          :class="{ disabled: !enabledModel || syncing }"
          @click="enabledModel ? void startCuratedLibrarySync() : undefined"
        >
          {{ t('cloudSync.curatedLibrary.syncNow') }}
        </div>
      </bubbleBoxTrigger>
    </div>

    <div class="status-row">
      <span class="status-label">{{ t('cloudSync.curatedLibrary.liveStatus') }}</span>
      <span class="status-value" :class="{ on: overview.liveConnected }">
        {{
          overview.liveConnected
            ? t('cloudSync.curatedLibrary.liveConnected')
            : t('cloudSync.curatedLibrary.liveDisconnected')
        }}
      </span>
    </div>
    <div class="setting-hint">{{ t('cloudSync.curatedLibrary.liveHint') }}</div>

    <div class="status-row">
      <span class="status-label">{{ t('cloudSync.curatedLibrary.quota') }}</span>
      <span class="status-value" :class="{ warn: quotaNearFull }">
        {{
          overview.quotaBytes > 0
            ? t('cloudSync.curatedLibrary.quotaValue', {
                used: formatAnalysisRuntimeBytes(overview.quotaUsedBytes),
                limit: formatAnalysisRuntimeBytes(overview.quotaBytes),
                count: overview.fileCount
              })
            : t('cloudSync.curatedLibrary.quotaUnknown', {
                used: formatAnalysisRuntimeBytes(overview.quotaUsedBytes)
              })
        }}
      </span>
    </div>
    <div v-if="overview.quotaBytes > 0" class="quota-bar" :class="{ warn: quotaNearFull }">
      <div class="quota-bar-fill" :style="{ width: `${quotaPercent}%` }" />
    </div>
    <div v-if="quotaNearFull" class="setting-hint warn-hint">
      {{ t('cloudSync.curatedLibrary.quotaNearFull') }}
    </div>

    <template v-if="overview.conflicts.length > 0">
      <div class="status-row">
        <span class="status-label">{{ t('cloudSync.curatedLibrary.conflictsTitle') }}</span>
        <span class="status-value warn">
          {{ t('cloudSync.curatedLibrary.conflictsCount', { count: overview.conflicts.length }) }}
        </span>
      </div>
      <div class="buttonRow">
        <div class="button settings-inline-button" @click="void showConflicts()">
          {{ t('cloudSync.curatedLibrary.viewConflicts') }}
        </div>
        <div class="button settings-inline-button" @click="void clearConflicts()">
          {{ t('cloudSync.curatedLibrary.clearConflicts') }}
        </div>
      </div>
    </template>

    <template v-if="overview.failures.length > 0">
      <div class="status-row">
        <span class="status-label">{{ t('cloudSync.curatedLibrary.failuresTitle') }}</span>
        <span class="status-value warn">{{ overview.failures.length }}</span>
      </div>
      <div class="failure-list">
        <div
          v-for="(item, index) in visibleFailures"
          :key="`${item.atMs}-${item.name}-${index}`"
          class="failure-row"
        >
          <bubbleBoxTrigger tag="div" class="failure-name" :title="item.name" only-when-overflow>
            {{ item.name }}
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            tag="div"
            class="failure-meta"
            :title="failureText(item)"
            only-when-overflow
          >
            {{ failureText(item) }}
          </bubbleBoxTrigger>
        </div>
      </div>
      <div v-if="extraFailureCount > 0" class="setting-hint">
        {{ t('cloudSync.curatedLibrary.failuresMore', { count: extraFailureCount }) }}
      </div>
      <div class="buttonRow">
        <bubbleBoxTrigger
          tag="div"
          class="button-anchor"
          :title="enabledModel ? '' : t('cloudSync.curatedLibrary.errors.notEnabled')"
        >
          <div
            class="button settings-inline-button"
            :class="{ disabled: !enabledModel || syncing }"
            @click="enabledModel ? void retryFailures() : undefined"
          >
            {{ t('cloudSync.curatedLibrary.retryAll') }}
          </div>
        </bubbleBoxTrigger>
        <div class="button settings-inline-button" @click="void clearFailures()">
          {{ t('cloudSync.curatedLibrary.clearFailures') }}
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.setting-block {
  margin-top: 20px;
}

label.setting-block {
  display: block;
  user-select: none;
}

.setting-control {
  margin-top: 10px;
  max-width: 100%;
}

.setting-hint {
  font-size: 12px;
  color: var(--text-secondary, #8c8c8c);
  margin-top: 8px;
  line-height: 1.5;
}

.buttonRow {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.button-anchor {
  width: fit-content;
}

.settings-inline-button {
  width: fit-content;
  min-width: 110px;
  text-align: center;
}

.settings-inline-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}

.status-label {
  color: var(--text-secondary, #8c8c8c);
}

.status-value.on {
  color: var(--accent, #3d8bfd);
}

.status-value.warn,
.warn-hint {
  color: var(--error, #f56c6c);
}

.quota-bar {
  margin-top: 8px;
  width: min(360px, 100%);
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--border);
}

.quota-bar-fill {
  height: 100%;
  background: var(--accent, #3d8bfd);
}

.quota-bar.warn .quota-bar-fill {
  background: var(--error, #f56c6c);
}

.failure-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(520px, 100%);
}

.failure-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr);
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
}

.failure-name,
.failure-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.5;
}

.failure-name {
  color: var(--text);
}

.failure-meta {
  color: var(--text-secondary, #8c8c8c);
}
</style>
