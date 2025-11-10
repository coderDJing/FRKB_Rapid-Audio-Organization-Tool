<script setup lang="ts">
import { onUnmounted, onMounted, ref, useTemplateRef, reactive, computed } from 'vue'
import hintIcon from '@renderer/assets/hint.png?asset'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import confirm from '@renderer/components/confirmDialog'
import globalCallShortcutDialog from './globalCallShortcutDialog'
import dangerConfirmWithInput from './dangerConfirmWithInputDialog'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import { SUPPORTED_AUDIO_FORMATS } from '../../../shared/audioFormats'
const runtime = useRuntimeStore()
const uuid = uuidV4()
const emits = defineEmits(['cancel'])

// 响应式的指纹库长度数据
const songFingerprintListLength = ref(0)

// 获取指纹库长度
const getSongFingerprintListLength = async () => {
  try {
    const length = await window.electron.ipcRenderer.invoke('getSongFingerprintListLength')
    songFingerprintListLength.value = length
  } catch (error) {
    console.error('获取指纹库长度失败:', error)
    songFingerprintListLength.value = 0
  }
}

// 假设 runtime.setting 中已有或需要添加 enablePlaybackRange
if (runtime.setting.enablePlaybackRange === undefined) {
  runtime.setting.enablePlaybackRange = false // 默认禁用
}
// 假设 runtime.setting 中已有 startPlayPercent 和 endPlayPercent 用于 songPlayer
if (runtime.setting.startPlayPercent === undefined) {
  runtime.setting.startPlayPercent = 0
}
if (runtime.setting.endPlayPercent === undefined) {
  runtime.setting.endPlayPercent = 100
}
// 最近使用歌单缓存数量默认值
if (runtime.setting.recentDialogSelectedSongListMaxCount === undefined) {
  runtime.setting.recentDialogSelectedSongListMaxCount = 10
}
// 错误日志上报默认值
if ((runtime as any).setting.enableErrorReport === undefined) {
  ;(runtime as any).setting.enableErrorReport = true
}
if ((runtime as any).setting.errorReportUsageMsSinceLastSuccess === undefined) {
  ;(runtime as any).setting.errorReportUsageMsSinceLastSuccess = 0
}
if ((runtime as any).setting.errorReportRetryMsSinceLastFailure === undefined) {
  ;(runtime as any).setting.errorReportRetryMsSinceLastFailure = -1
}

// 是否在重启后保留曲目筛选条件：默认不保留
if ((runtime as any).setting.persistSongFilters === undefined) {
  ;(runtime as any).setting.persistSongFilters = false
}

// 歌单行气泡提示显示策略：默认仅在文字被截断时显示（false）
if ((runtime as any).setting.songListBubbleAlways === undefined) {
  ;(runtime as any).setting.songListBubbleAlways = false
}

// 将布尔设置映射为单选值（与指纹模式类似的布局与交互）
const songListBubbleMode = computed<'overflowOnly' | 'always'>({
  get() {
    return (runtime as any).setting.songListBubbleAlways ? 'always' : 'overflowOnly'
  },
  set(v) {
    ;(runtime as any).setting.songListBubbleAlways = v === 'always'
  }
})

// 修改后的 cancel 函数 - 移除了范围验证和保存
const cancel = async () => {
  emits('cancel')
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
  // 获取指纹库长度
  getSongFingerprintListLength()
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  await getSongFingerprintListLength()
}

// 更新“最近使用歌单缓存数量”并按需截断本地缓存
const updateRecentDialogCacheMaxCount = async () => {
  runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
    0,
    Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
  )
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount
  const keys = ['FilterLibrary', 'CuratedLibrary']
  for (const name of keys) {
    const key = 'recentDialogSelectedSongListUUID' + name
    const raw = localStorage.getItem(key)
    if (!raw) continue
    try {
      let arr: string[] = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length > maxCount) {
        arr = arr.slice(0, maxCount)
        localStorage.setItem(key, JSON.stringify(arr))
      }
    } catch (e) {
      // ignore broken cache
    }
  }
  await setSetting()
}

// 所有支持的格式列表
const allFormats = SUPPORTED_AUDIO_FORMATS

type AudioFormatKey = (typeof allFormats)[number]
type AudioExt = Record<AudioFormatKey, boolean>

const audioExt = ref<AudioExt>(
  Object.fromEntries(
    allFormats.map((fmt) => [fmt, runtime.setting.audioExt.includes(`.${fmt}`)])
  ) as AudioExt
)

let audioExtOld = JSON.parse(JSON.stringify(audioExt.value)) as AudioExt
const extChange = async () => {
  if (runtime.isProgressing) {
    audioExt.value = { ...audioExtOld }
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  audioExtOld = JSON.parse(JSON.stringify(audioExt.value))
  const audioExtArr = Object.entries(audioExt.value)
    .filter(([, checked]) => checked)
    .map(([fmt]) => `.${fmt}`)
  runtime.setting.audioExt = audioExtArr
  setSetting()
}
const clearTracksFingerprintLibrary = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  let resConfirm = await confirm({
    title: t('common.warning'),
    content: [t('fingerprints.confirmClear')]
  })
  if (resConfirm === 'confirm') {
    try {
      const result = await window.electron.ipcRenderer.invoke('clearTracksFingerprintLibrary')
      if (result && result.success) {
        await getSongFingerprintListLength()
        await confirm({
          title: t('common.setting'),
          content: [t('fingerprints.clearCompleted')],
          confirmShow: false
        })
      } else {
        await confirm({
          title: t('common.setting'),
          content: [t('fingerprints.clearFailed'), String(result?.message || '')],
          confirmShow: false
        })
      }
    } catch (error) {
      await confirm({
        title: t('common.setting'),
        content: [t('fingerprints.clearFailed'), String((error as any)?.message || '')],
        confirmShow: false
      })
    }
  }
}

const globalCallShortcutHandle = async () => {
  await globalCallShortcutDialog()
}

const reSelectLibrary = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  let res = await confirm({
    title: t('dialog.hint'),
    content: [t('database.locationRetain'), t('database.reselectConfirm')],
    confirmShow: true
  })
  if (res === 'confirm') {
    setSetting()
    await window.electron.ipcRenderer.invoke('reSelectLibrary')
  }
}
const hint1Ref = useTemplateRef<HTMLImageElement>('hint1Ref')
const hintErrorReportRef = useTemplateRef<HTMLImageElement>('hintErrorReportRef')

// 指纹模式选项的 hint 图标引用
const fpModeHintRefs = reactive<Record<string, HTMLImageElement | null>>({})
function setFpModeHintRef(value: string, el: HTMLImageElement | null) {
  if (el) fpModeHintRefs[value] = el
}

// 切换指纹模式时的提示
const onFingerprintModeChange = async () => {
  await confirm({
    title: t('fingerprints.mode'),
    content: [t('fingerprints.modeIncompatibleWarning')],
    confirmShow: false
  })
  await setSetting()
}

// 清除云端指纹库
const clearCloudFingerprints = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  const userKey = cfg?.userKey || ''
  if (!userKey) {
    emits('cancel')
    window.dispatchEvent(new CustomEvent('openDialogFromChild', { detail: 'cloudSync.settings' }))
    await confirm({
      title: t('cloudSync.settings'),
      content: [t('cloudSync.needUserKeyBeforeDanger')],
      confirmShow: false
    })
    return
  }
  const danger = await dangerConfirmWithInput({
    title: t('cloudSync.reset.title'),
    description: t('cloudSync.reset.description'),
    confirmKeyword: 'DELETE',
    placeholder: 'DELETE'
  })
  if (danger === 'cancel') return
  try {
    const res = await window.electron.ipcRenderer.invoke('cloudSync/resetUserData', {
      notes: 'reset from client'
    })
    if (res?.success) {
      await confirm({
        title: t('common.success'),
        content: [t('cloudSync.reset.success')],
        confirmShow: false
      })
    } else {
      const msgKey = res?.message || 'common.error'
      await confirm({ title: t('common.error'), content: [t(msgKey)], confirmShow: false })
    }
  } catch (e: any) {
    await confirm({
      title: t('common.error'),
      content: [t('cloudSync.errors.cannotConnect')],
      confirmShow: false
    })
  }
}
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 60vw;
        height: 70vh;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
      v-dialog-drag="'.dialog-title'"
    >
      <div style="height: 100%; display: flex; flex-direction: column">
        <div
          class="dialog-title"
          style="text-align: center; height: 30px; line-height: 30px; font-size: 14px"
        >
          <span style="font-weight: bold">{{ t('common.setting') }}</span>
        </div>
        <OverlayScrollbarsComponent
          :options="{
            scrollbars: {
              autoHide: 'leave' as const,
              autoHideDelay: 50,
              clickScroll: true
            } as const,
            overflow: {
              x: 'hidden',
              y: 'scroll'
            } as const
          }"
          element="div"
          style="height: 100%; width: 100%"
          defer
        >
          <div style="padding: 20px; font-size: 14px; flex-grow: 1">
            <div>{{ t('theme.mode') }}：</div>
            <div style="margin-top: 10px">
              <select v-model="(runtime as any).setting.themeMode" @change="setSetting">
                <option value="system">{{ t('theme.system') }}</option>
                <option value="light">{{ t('theme.light') }}</option>
                <option value="dark">{{ t('theme.dark') }}</option>
              </select>
            </div>
            <div style="margin-top: 20px">{{ t('common.language') }}：</div>
            <div style="margin-top: 10px">
              <select v-model="runtime.setting.language" @change="setSetting">
                <option value="zhCN">简体中文</option>
                <option value="enUS">English</option>
              </select>
            </div>
            <div style="margin-top: 20px">{{ t('player.autoPlayNext') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox v-model="runtime.setting.autoPlayNextSong" @change="setSetting()" />
            </div>
            <div style="margin-top: 20px">{{ t('player.enablePlaybackRange') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="runtime.setting.enablePlaybackRange"
                @change="setSetting()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('player.hideControlsShowWaveform') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="runtime.setting.hiddenPlayControlArea"
                @change="setSetting()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('fingerprints.scanFormats') }}：</div>
            <div style="margin-top: 10px">
              <div style="display: flex; flex-wrap: wrap; gap: 10px">
                <template v-for="fmt in allFormats" :key="fmt">
                  <div style="display: flex; align-items: center">
                    <span style="margin-right: 5px">.{{ fmt }}</span>
                    <singleCheckbox v-model="(audioExt as any)[fmt]" @change="extChange()" />
                  </div>
                </template>
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('shortcuts.globalCallShortcut') }}：</div>
            <div style="margin-top: 10px">
              <div
                class="chooseDirDiv"
                @click="globalCallShortcutHandle()"
                :title="runtime.setting.globalCallShortcut"
              >
                {{ runtime.setting.globalCallShortcut }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('player.fastForwardTime') }}：</div>
            <div style="margin-top: 10px">
              <input
                class="myInput"
                v-model="runtime.setting.fastForwardTime"
                type="number"
                min="1"
                step="1"
                @input="
                  runtime.setting.fastForwardTime = Math.max(
                    1,
                    Math.floor(Number(runtime.setting.fastForwardTime || 1)) // 处理可能为 null 或 undefined 的情况
                  )
                "
                @blur="setSetting()"
              />
              {{ t('player.seconds') }}
            </div>
            <div style="margin-top: 20px">{{ t('player.fastBackwardTime') }}：</div>
            <div style="margin-top: 10px">
              <input
                class="myInput"
                v-model="runtime.setting.fastBackwardTime"
                type="number"
                max="-1"
                step="1"
                @input="
                  runtime.setting.fastBackwardTime = Math.min(
                    -1,
                    Math.floor(Number(runtime.setting.fastBackwardTime || -1)) // 处理可能为 null 或 undefined 的情况
                  )
                "
                @blur="setSetting()"
              />
              {{ t('player.seconds') }}
            </div>
            <div style="margin-top: 20px">{{ t('player.autoCenterSong') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="runtime.setting.autoScrollToCurrentSong"
                @change="setSetting()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('player.recentPlaylistCache') }}：</div>
            <div style="margin-top: 10px">
              <input
                class="myInput"
                v-model="runtime.setting.recentDialogSelectedSongListMaxCount"
                type="number"
                min="0"
                step="1"
                @input="
                  runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
                    0,
                    Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
                  )
                "
                @blur="updateRecentDialogCacheMaxCount()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('filters.persistFiltersAfterRestart') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="(runtime as any).setting.persistSongFilters"
                @change="setSetting()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('settings.showPlaylistTrackCount') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="(runtime as any).setting.showPlaylistTrackCount"
                @change="setSetting()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('settings.songListBubble.title') }}：</div>
            <div style="margin-top: 10px">
              <singleRadioGroup
                name="songListBubble"
                :options="[
                  { label: t('settings.songListBubble.overflowOnly'), value: 'overflowOnly' },
                  { label: t('settings.songListBubble.always'), value: 'always' }
                ]"
                v-model="songListBubbleMode as any"
                :optionFontSize="12"
                @change="setSetting()"
              >
                <template #option="{ opt }">
                  <span class="label">{{ opt.label }}</span>
                </template>
              </singleRadioGroup>
              <div style="margin-top: 6px; font-size: 12px; color: #999">
                {{ t('settings.songListBubble.hint') }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('database.reselectLocation') }}：</div>
            <div style="margin-top: 10px">
              <div
                class="button"
                style="width: 90px; text-align: center"
                @click="reSelectLibrary()"
              >
                {{ t('dialog.reselect') }}
              </div>
            </div>
            <div style="margin-top: 20px">
              {{ t('fingerprints.clear') }}：
              <img
                ref="hint1Ref"
                :src="hintIcon"
                style="width: 15px; height: 15px; margin-top: 5px"
                :draggable="false"
                class="theme-icon"
              />
              <bubbleBox
                :dom="hint1Ref || undefined"
                :title="t('fingerprints.currentCount', { count: songFingerprintListLength })"
                :maxWidth="220"
              />
            </div>
            <div style="margin-top: 10px">
              <div
                class="dangerButton"
                style="width: 90px; text-align: center"
                @click="clearTracksFingerprintLibrary()"
              >
                {{ t('fingerprints.clearShort') }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('cloudSync.reset.sectionTitle') }}：</div>
            <div style="margin-top: 10px">
              <div
                class="dangerButton"
                style="width: 90px; text-align: center"
                @click="clearCloudFingerprints()"
              >
                {{ t('fingerprints.clearShort') }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('fingerprints.mode') }}：</div>
            <div style="margin-top: 10px">
              <singleRadioGroup
                name="fpMode"
                :options="[
                  { label: t('fingerprints.modePCM'), value: 'pcm' },
                  { label: t('fingerprints.modeFile'), value: 'file' }
                ]"
                v-model="(runtime as any).setting.fingerprintMode as any"
                @change="onFingerprintModeChange()"
              >
                <template #option="{ opt }">
                  <span class="label">{{ opt.label }}</span>
                  <img
                    :ref="(el: any) => setFpModeHintRef(opt.value, el)"
                    :src="hintIcon"
                    style="width: 14px; height: 14px; margin-left: 6px"
                    :draggable="false"
                  />
                  <bubbleBox
                    :dom="(fpModeHintRefs[opt.value] || undefined) as any"
                    :title="
                      opt.value === 'pcm'
                        ? t('fingerprints.modePCMHint')
                        : t('fingerprints.modeFileHint')
                    "
                    :maxWidth="360"
                  />
                </template>
              </singleRadioGroup>
              <div style="margin-top: 8px; font-size: 12px; color: #999">
                {{ t('fingerprints.modeIncompatibleWarning') }}
              </div>
            </div>
            <div style="margin-top: 20px">
              {{ t('errorReport.enable') }}：
              <img
                ref="hintErrorReportRef"
                :src="hintIcon"
                style="width: 15px; height: 15px; margin-top: 5px"
                :draggable="false"
                class="theme-icon"
              />
              <bubbleBox
                :dom="hintErrorReportRef || undefined"
                :title="t('errorReport.hint')"
                :maxWidth="260"
              />
            </div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="(runtime as any).setting.enableErrorReport"
                @change="setSetting()"
              />
            </div>
          </div>
        </OverlayScrollbarsComponent>
        <div style="display: flex; justify-content: center; padding-bottom: 10px; height: 30px">
          <div class="button" @click="cancel">{{ t('common.close') }} (Esc)</div>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.myInput {
  width: 50px;
  height: 19px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 3px;
  padding: 0 6px;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  border: 1px solid var(--border);
  font-size: 14px;

  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}

select {
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 14px;
  width: 200px;
  height: 25px;
  padding-left: 5px;
  outline: none;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

/* 美化选项内容 */
option {
  padding: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
}

.chooseDirDiv {
  height: 25px;
  line-height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  width: 200px;
  font-size: 14px;
  padding-left: 5px;
  box-sizing: border-box;
  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}
</style>
