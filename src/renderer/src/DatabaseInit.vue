<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, useTemplateRef, reactive } from 'vue'
import { t } from '@renderer/utils/translate'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import choice from '@renderer/components/choiceDialog'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import hintIcon from '@renderer/assets/hint.png?asset'
const runtime = useRuntimeStore()
const uuid = uuidV4()
const flashArea = ref('') // 控制动画是否正在播放

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
const fingerprintMode = ref<'pcm' | 'file' | ''>('')
// 单选项级别的 hint 绑定：为每个选项的图标保存一个 ref
const optionHintRefs = reactive<Record<string, HTMLImageElement | null>>({})
function setOptionHintRef(value: string, el: HTMLImageElement | null) {
  if (el) optionHintRefs[value] = el
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
      { createSamples: false, fingerprintMode: (fingerprintMode.value || 'file') as any }
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
    { createSamples: true, fingerprintMode: fingerprintMode.value as any }
  )
}
const cancel = () => {
  window.electron.ipcRenderer.send('databaseInitWindow-toggle-close')
}
onMounted(async () => {
  hotkeys('E', uuid, () => {
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
  utils.delHotkeysScope(uuid)
})

window.electron.ipcRenderer.on('databaseInitWindow-showErrorHint', async (event, databaseUrl) => {
  await confirm({
    title: t('common.error'),
    content: [databaseUrl, t('database.cannotRead'), t('database.possibleDamage')],
    confirmShow: false
  })
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
    <div
      style="text-align: center; height: 30px; line-height: 30px; font-size: 15px"
      class="canDrag"
    >
      <span style="font-weight: bold" class="title unselectable">{{
        t('database.selectLocation')
      }}</span>
    </div>

    <div style="padding: 10px 20px 0 20px">
      <div class="tabs">
        <div class="tab" :class="{ active: activeTab === 'create' }" @click="activeTab = 'create'">
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
          <div class="fieldLabel" style="font-size: 14px">{{ t('database.chooseExistingDb') }}</div>
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
          <div
            class="chooseDirDiv flashing-border"
            @click="clickChooseDir()"
            :title="folderPathVal"
            :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
            style="width: 100%"
          >
            {{ folderPathVal || t('database.pickFolder') }}
          </div>
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
              :options="[
                { label: t('fingerprints.modePCM'), value: 'pcm' },
                { label: t('fingerprints.modeFile'), value: 'file' }
              ]"
              v-model="fingerprintMode as any"
              name="fpModeInit"
              :optionFontSize="12"
            >
              <template #option="{ opt }">
                <span class="label">{{ opt.label }}</span>
                <img
                  :ref="(el: any) => setOptionHintRef(opt.value, el)"
                  :src="hintIcon"
                  style="width: 14px; height: 14px; margin-left: 6px"
                  :draggable="false"
                />
                <bubbleBox
                  :dom="(optionHintRefs[opt.value] || undefined) as any"
                  :title="
                    opt.value === 'pcm'
                      ? t('fingerprints.modePCMHint')
                      : t('fingerprints.modeFileHint')
                  "
                  :maxWidth="360"
                />
              </template>
            </singleRadioGroup>
          </div>
          <div class="helper" style="font-size: 11px; color: #999">
            {{ t('fingerprints.modeIncompatibleWarning') }}
          </div>
        </div>
      </template>
    </div>

    <div style="display: flex; justify-content: center; padding: 10px 0 12px 0; gap: 10px">
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
  </div>
</template>
<style lang="scss">
#app {
  color: #cccccc;
  background-color: #181818;
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: #1f1f1f;
}

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid #2a2a2a;
}

.tab {
  padding: 6px 12px;
  cursor: pointer;
  color: #bbbbbb;
  font-size: 12px;
}

.tab.active {
  color: #ffffff;
  border-bottom: 2px solid #ffffff;
  font-size: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fieldLabel {
  color: #bbbbbb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.helper {
  font-size: 11px;
  color: #999;
}

.chooseDirDiv {
  height: 28px;
  background-color: #313131;
  box-sizing: border-box;

  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  font-size: 12px;
  padding-left: 5px;
  line-height: 28px;
}

.nameInput {
  height: 28px;
  line-height: 28px;
  background-color: #313131;
  border: 0;
  outline: none;
  color: #cccccc;
  box-sizing: border-box;
  padding: 0 0 0 5px;
  font-size: 12px;
  -webkit-appearance: none;
  appearance: none;
}

/* 复用筛选弹窗的单选样式，保持一致视觉 */
.radio-group {
  display: flex;
  gap: 16px;
  margin-bottom: 10px;
  color: #cccccc;
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
  border: 1px solid #3a3a3a;
  background: transparent;
  position: relative;
  transition: all 0.15s ease;
}

.radio .dot::after {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  background: #0078d4;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.radio input[type='radio']:checked + .dot::after {
  opacity: 1;
}

.radio:hover .dot {
  border-color: #5a5a5a;
  background: rgba(255, 255, 255, 0.02);
}
</style>
