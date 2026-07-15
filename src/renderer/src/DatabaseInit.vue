<script setup lang="ts">
import {
  ref,
  onMounted,
  onUnmounted,
  computed,
  reactive,
  watch,
  type ComponentPublicInstance
} from 'vue'
import { t } from '@renderer/utils/translate'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import choice from '@renderer/components/choiceDialog'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import { formatWindowTitle } from '@renderer/utils/windowTitle'
const runtime = useRuntimeStore()
const uuid = uuidV4()
const isSchemaMigrationMode =
  new URLSearchParams(window.location.search).get('mode') === 'schema-migration'
const flashArea = ref('') // 控制动画是否正在播放
const hintIcon = hintIconAsset
type FingerprintMode = 'pcm' | 'file'
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
const databaseInitWindowTitle = computed(() =>
  formatWindowTitle(
    isSchemaMigrationMode ? t('database.schemaMigrationTitle') : t('database.selectLocation')
  )
)
const schemaMigrationProgress = ref<SchemaMigrationProgress | null>(null)
const schemaMigrationIsBlocking = computed(
  () => !!schemaMigrationProgress.value && schemaMigrationProgress.value.phase !== 'failed'
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

// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = '' // 动画结束，不再闪烁
    }
  }, 500) // 每次闪烁间隔 500 毫秒
}

// Tab 状态：create | existing
const activeTab = ref<'create' | 'existing'>('create')

// 新建库：父路径与子文件夹名
const folderPathVal = ref('')
const dbName = ref('')
const sep = computed(() => (runtime.setting.platform === 'win32' ? '\\' : '/'))
const targetDir = computed(() =>
  folderPathVal.value && dbName.value.trim()
    ? folderPathVal.value.replace(/[\\/]+$/, '') + sep.value + dbName.value.trim()
    : ''
)

// 基于系统是否隐藏扩展名，动态生成需要提示的清单文件名
const windowsHideExt = ref(false)
const manifestDisplayName = computed(() =>
  windowsHideExt.value ? 'FRKB.database' : 'FRKB.database.frkbdb'
)

// 必选：指纹模式（'pcm' | 'file'），默认为空，用户必须选择
const fingerprintMode = ref<FingerprintMode | ''>('')
const normalizeFingerprintMode = (
  value: unknown,
  fallback: FingerprintMode = 'pcm'
): FingerprintMode => (value === 'file' ? 'file' : value === 'pcm' ? 'pcm' : fallback)
const fingerprintModeModel = computed<string>({
  get: () => fingerprintMode.value,
  set: (value) => {
    fingerprintMode.value = value === 'file' ? 'file' : value === 'pcm' ? 'pcm' : ''
  }
})
// 单选项级别的 hint 绑定：为每个选项的图标保存一个 ref
const optionHintRefs = reactive<Record<string, HTMLElement | null>>({})
const resolveTemplateElement = (
  value: Element | ComponentPublicInstance | null
): HTMLElement | null => {
  if (value instanceof HTMLElement) return value
  if (!value || typeof value !== 'object' || !('$el' in value)) return null
  return value.$el instanceof HTMLElement ? value.$el : null
}
function setOptionHintRef(value: string, el: Element | ComponentPublicInstance | null) {
  optionHintRefs[value] = resolveTemplateElement(el)
}

let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag) {
    return
  }
  clickChooseDirFlag = true
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder', false)
  clickChooseDirFlag = false
  if (folderPath) {
    // 向上探测：若父路径位于库内则三选项
    const selected = folderPath[0]
    let root: string | null = null
    try {
      root = await window.electron.ipcRenderer.invoke('find-db-root-upwards', selected)
    } catch {}
    if (root) {
      const key = await choice({
        title: t('common.warning'),
        content: [t('database.parentIsInsideDb')],
        options: [
          { key: 'enter', label: t('database.enterExisting') },
          { key: 'reset', label: t('database.resetRebuild') },
          { key: 'cancel', label: t('common.cancel') }
        ],
        innerHeight: 220,
        innerWidth: 520
      })
      if (key === 'enter') {
        runtime.setting.databaseUrl = root
        await window.electron.ipcRenderer.invoke(
          'setSetting',
          JSON.parse(JSON.stringify(runtime.setting))
        )
        await window.electron.ipcRenderer.invoke(
          'databaseInitWindow-InitDataBase',
          runtime.setting.databaseUrl,
          { createSamples: false }
        )
      } else if (key === 'reset') {
        runtime.setting.databaseUrl = root
        await window.electron.ipcRenderer.invoke(
          'setSetting',
          JSON.parse(JSON.stringify(runtime.setting))
        )
        await window.electron.ipcRenderer.invoke(
          'databaseInitWindow-InitDataBase',
          runtime.setting.databaseUrl,
          { createSamples: true, reset: true }
        )
      }
      return
    }
    folderPathVal.value = selected
  }
}

const clickChooseExistingDb = async () => {
  const result = await window.electron.ipcRenderer.invoke('select-existing-database-file')
  if (!result) return
  if (result && result.error === 'incompatible') {
    await confirm({
      title: t('common.error'),
      content: [
        t('database.incompatibleManifest', {
          minVersion: result.minAppVersion || '-',
          currentVersion: result.appVersion || '-'
        })
      ],
      confirmShow: false
    })
    return
  }
  if (result === 'error') {
    await confirm({
      title: t('common.error'),
      content: [t('database.invalidManifestFile')],
      confirmShow: false
    })
    return
  }
  runtime.setting.databaseUrl = result.rootDir
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  await window.electron.ipcRenderer.invoke(
    'databaseInitWindow-InitDataBase',
    runtime.setting.databaseUrl,
    { createSamples: false }
  )
}

const submitConfirm = async () => {
  if (activeTab.value !== 'create') {
    return
  }
  if (folderPathVal.value.length === 0) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  if (dbName.value.trim().length === 0) {
    if (!flashArea.value) {
      flashBorder('dbName')
    }
    return
  }
  if (!fingerprintMode.value) {
    if (!flashArea.value) {
      flashBorder('fingerprintMode')
    }
    return
  }

  // 再次检查：父路径是否处于某库内部
  try {
    const root = await window.electron.ipcRenderer.invoke(
      'find-db-root-upwards',
      folderPathVal.value
    )
    if (root) {
      const key = await choice({
        title: t('common.warning'),
        content: [t('database.parentIsInsideDb')],
        options: [
          { key: 'enter', label: t('database.enterExisting') },
          { key: 'reset', label: t('database.resetRebuild') },
          { key: 'cancel', label: t('common.cancel') }
        ],
        innerHeight: 220,
        innerWidth: 520
      })
      if (key === 'enter') {
        runtime.setting.databaseUrl = root
        await window.electron.ipcRenderer.invoke(
          'setSetting',
          JSON.parse(JSON.stringify(runtime.setting))
        )
        await window.electron.ipcRenderer.invoke(
          'databaseInitWindow-InitDataBase',
          runtime.setting.databaseUrl,
          { createSamples: false }
        )
      } else if (key === 'reset') {
        runtime.setting.databaseUrl = root
        await window.electron.ipcRenderer.invoke(
          'setSetting',
          JSON.parse(JSON.stringify(runtime.setting))
        )
        await window.electron.ipcRenderer.invoke(
          'databaseInitWindow-InitDataBase',
          runtime.setting.databaseUrl,
          { createSamples: true, reset: true }
        )
      }
      return
    }
  } catch {}

  const dirForCreate = targetDir.value
  if (!dirForCreate) return

  // 探测目标子目录状态
  let probe: { hasManifest: boolean; isLegacy: boolean; isEmpty: boolean } = {
    hasManifest: false,
    isLegacy: false,
    isEmpty: false
  }
  try {
    probe = await window.electron.ipcRenderer.invoke('probe-database-dir', dirForCreate)
  } catch {}

  if (probe.hasManifest) {
    const key = await choice({
      title: t('common.warning'),
      content: [t('database.dirHasDatabase'), t('database.dirHasDatabaseOptions')],
      options: [
        { key: 'enter', label: t('database.enterExisting') },
        { key: 'reset', label: t('database.resetRebuild') },
        { key: 'cancel', label: t('common.cancel') }
      ],
      innerHeight: 220,
      innerWidth: 520
    })
    if (key === 'enter') {
      runtime.setting.databaseUrl = dirForCreate
      await window.electron.ipcRenderer.invoke(
        'setSetting',
        JSON.parse(JSON.stringify(runtime.setting))
      )
      await window.electron.ipcRenderer.invoke(
        'databaseInitWindow-InitDataBase',
        runtime.setting.databaseUrl,
        { createSamples: false }
      )
      return
    } else if (key === 'reset') {
      runtime.setting.databaseUrl = dirForCreate
      await window.electron.ipcRenderer.invoke(
        'setSetting',
        JSON.parse(JSON.stringify(runtime.setting))
      )
      await window.electron.ipcRenderer.invoke(
        'databaseInitWindow-InitDataBase',
        runtime.setting.databaseUrl,
        { createSamples: true, reset: true }
      )
      return
    }
    return
  }

  if (probe.isLegacy) {
    runtime.setting.databaseUrl = dirForCreate
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
    await window.electron.ipcRenderer.invoke(
      'databaseInitWindow-InitDataBase',
      runtime.setting.databaseUrl,
      {
        createSamples: false,
        fingerprintMode: normalizeFingerprintMode(fingerprintMode.value, 'file')
      }
    )
    return
  }

  // 不存在或为空：正常新建
  runtime.setting.databaseUrl = dirForCreate
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  await window.electron.ipcRenderer.invoke(
    'databaseInitWindow-InitDataBase',
    runtime.setting.databaseUrl,
    { createSamples: true, fingerprintMode: normalizeFingerprintMode(fingerprintMode.value) }
  )
}
const cancel = () => {
  if (isSchemaMigrationMode) return
  if (schemaMigrationIsBlocking.value) return
  window.electron.ipcRenderer.send('databaseInitWindow-toggle-close')
}
const closeSchemaMigrationWindow = () => {
  if (!isSchemaMigrationMode || schemaMigrationProgress.value?.phase !== 'failed') return
  window.electron.ipcRenderer.send('databaseSchemaMigrationWindow-close')
}
onMounted(async () => {
  if (isSchemaMigrationMode) return
  hotkeys('E,Enter', uuid, () => {
    submitConfirm()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
  try {
    const hidden = await window.electron.ipcRenderer.invoke('get-windows-hide-ext')
    windowsHideExt.value = !!hidden
  } catch {}
})

onUnmounted(() => {
  if (isSchemaMigrationMode) return
  utils.delHotkeysScope(uuid)
})

type DatabaseInitErrorHint =
  | {
      kind: 'schema-too-new'
      databaseUrl: string
      databaseVersion: number
      maximumSupportedVersion: number
    }
  | {
      kind: 'cannot-read'
      databaseUrl: string
    }

window.electron.ipcRenderer.on('databaseInitWindow-showErrorHint', async (_event, payload) => {
  const hint: DatabaseInitErrorHint =
    typeof payload === 'string'
      ? { kind: 'cannot-read', databaseUrl: payload }
      : (payload as DatabaseInitErrorHint)
  if (hint.kind === 'schema-too-new') {
    await confirm({
      title: t('common.error'),
      content: [
        hint.databaseUrl,
        t('database.schemaTooNew'),
        t('database.schemaVersion', {
          databaseVersion: hint.databaseVersion,
          maximumSupportedVersion: hint.maximumSupportedVersion
        }),
        t('database.updateRequired')
      ],
      confirmShow: false
    })
    return
  }
  await confirm({
    title: t('common.error'),
    content: [hint.databaseUrl, t('database.cannotRead'), t('database.possibleDamage')],
    confirmShow: false
  })
})

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
    <template v-if="isSchemaMigrationMode">
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
    </template>
    <template v-else>
      <div
        style="text-align: center; height: 30px; line-height: 30px; font-size: 15px"
        class="canDrag"
      >
        <span style="font-weight: bold" class="title unselectable">{{
          databaseInitWindowTitle
        }}</span>
      </div>

      <div style="padding: 10px 20px 0 20px">
        <div class="tabs">
          <div
            class="tab"
            :class="{ active: activeTab === 'create' }"
            @click="activeTab = 'create'"
          >
            {{ t('database.createNewDb') }}
          </div>
          <div
            class="tab"
            :class="{ active: activeTab === 'existing' }"
            @click="activeTab = 'existing'"
          >
            {{ t('database.chooseExistingDb') }}
          </div>
        </div>
      </div>

      <div
        style="
          padding: 12px 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
          overflow: hidden;
          font-size: 14px;
        "
      >
        <template v-if="activeTab === 'existing'">
          <div class="field">
            <div class="fieldLabel" style="font-size: 14px">
              {{ t('database.chooseExistingDb') }}
            </div>
            <div>
              <div
                class="button"
                style="display: inline-block; text-align: center; padding: 0 12px; font-size: 12px"
                @click="clickChooseExistingDb()"
              >
                {{ t('database.pickManifestFile') }}
              </div>
            </div>
          </div>
          <div class="helper">
            {{ t('database.initHintExisting', { manifestName: manifestDisplayName }) }}
          </div>
        </template>

        <template v-else>
          <div class="field">
            <div class="fieldLabel" style="font-size: 14px">{{ t('database.createNewDb') }}</div>
            <bubbleBoxTrigger
              tag="div"
              class="chooseDirDiv flashing-border"
              :title="folderPathVal"
              :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
              style="width: 100%"
              @click="clickChooseDir()"
            >
              {{ folderPathVal || t('database.pickFolder') }}
            </bubbleBoxTrigger>
          </div>
          <div class="field">
            <div class="fieldLabel" style="font-size: 14px">{{ t('database.inputDbName') }}</div>
            <div>
              <input
                v-model="dbName"
                class="nameInput flashing-border"
                :class="{ 'is-flashing': flashArea == 'dbName' }"
                :placeholder="t('database.inputDbNamePlaceholder')"
                style="width: 100%"
              />
            </div>
          </div>
          <div class="helper">{{ t('database.initHintCreate') }}</div>
          <div class="field" style="border-radius: 4px">
            <div class="fieldLabel" style="display: flex; align-items: center; gap: 6px">
              <span>{{ t('fingerprints.mode') }}</span>
            </div>
            <div
              class="flashing-border"
              :class="{ 'is-flashing': flashArea == 'fingerprintMode' }"
              style="
                border-radius: 4px;
                padding-top: 6px;
                padding-bottom: 0px;
                padding-left: 8px;
                padding-right: 8px;
              "
            >
              <singleRadioGroup
                v-model="fingerprintModeModel"
                :options="[
                  { label: t('fingerprints.modePCM'), value: 'pcm' },
                  { label: t('fingerprints.modeFile'), value: 'file' }
                ]"
                name="fpModeInit"
                :option-font-size="12"
              >
                <template #option="{ opt }">
                  <span class="label">{{ opt.label }}</span>
                  <img
                    :ref="(el) => setOptionHintRef(opt.value, el)"
                    :src="hintIcon"
                    style="width: 14px; height: 14px; margin-left: 6px"
                    :draggable="false"
                    class="theme-icon"
                  />
                  <bubbleBox
                    :dom="optionHintRefs[opt.value] ?? null"
                    :title="
                      opt.value === 'pcm'
                        ? t('fingerprints.modePCMHint')
                        : t('fingerprints.modeFileHint')
                    "
                    :max-width="360"
                  />
                </template>
              </singleRadioGroup>
            </div>
            <div class="helper" style="font-size: 11px; color: var(--text-weak)">
              {{ t('fingerprints.modeIncompatibleWarning') }}
            </div>
          </div>
        </template>
      </div>

      <div
        v-if="!schemaMigrationIsBlocking"
        style="display: flex; justify-content: center; padding: 10px 0 12px 0; gap: 10px"
      >
        <div
          v-if="activeTab === 'create'"
          class="button"
          style="width: 120px; text-align: center"
          @click="submitConfirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 120px; text-align: center" @click="cancel()">
          {{ t('menu.exit') }} (Esc)
        </div>
      </div>
    </template>
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

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 6px 12px;
  cursor: pointer;
  color: var(--text-weak);
  font-size: 12px;
}

.tab.active {
  color: var(--accent);
  border-bottom: 2px solid var(--accent);
  font-size: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fieldLabel {
  color: var(--text-weak);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.helper {
  font-size: 11px;
  color: var(--text-weak);
}

.chooseDirDiv {
  height: 28px;
  background-color: var(--bg-elev);
  box-sizing: border-box;

  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  font-size: 12px;
  padding-left: 5px;
  line-height: 28px;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.nameInput {
  height: 28px;
  line-height: 28px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  box-sizing: border-box;
  padding: 0 0 0 5px;
  font-size: 12px;
  -webkit-appearance: none;
  appearance: none;
  border-radius: 3px;

  &::placeholder {
    color: var(--text-weak);
  }

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

/* 复用筛选弹窗的单选样式，保持一致视觉 */
.radio-group {
  display: flex;
  gap: 16px;
  margin-bottom: 10px;
  color: var(--text);
}

.radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
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

.radio:hover .dot {
  border-color: var(--border);
  background: rgba(0, 0, 0, 0.02);
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
