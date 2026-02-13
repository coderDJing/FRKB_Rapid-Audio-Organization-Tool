<script setup lang="ts">
import { onUnmounted, onMounted, ref, useTemplateRef, reactive, computed, watch } from 'vue'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import confirm from '@renderer/components/confirmDialog'
import globalCallShortcutDialog from './globalCallShortcutDialog'
import playerGlobalShortcutDialog from './playerGlobalShortcutDialog'
import dangerConfirmWithInput from './dangerConfirmWithInputDialog'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import { SUPPORTED_AUDIO_FORMATS } from '../../../shared/audioFormats'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'
import { mapAcoustIdClientError } from '@renderer/utils/acoustid'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const runtime = useRuntimeStore()
const uuid = uuidV4()
const emits = defineEmits(['cancel'])

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const hintIcon = hintIconAsset

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
// 是否显示闲时分析状态：默认不显示
if ((runtime as any).setting.showIdleAnalysisStatus === undefined) {
  ;(runtime as any).setting.showIdleAnalysisStatus = false
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
if ((runtime as any).setting.enableExplorerContextMenu === undefined) {
  ;(runtime as any).setting.enableExplorerContextMenu = runtime.setting.platform === 'win32'
}

// 歌单行气泡提示显示策略：默认仅在文字被截断时显示（false）
if ((runtime as any).setting.songListBubbleAlways === undefined) {
  ;(runtime as any).setting.songListBubbleAlways = false
}

if ((runtime as any).setting.acoustIdClientKey === undefined) {
  ;(runtime as any).setting.acoustIdClientKey = ''
}
if ((runtime as any).setting.autoFillSkipCompleted === undefined) {
  ;(runtime as any).setting.autoFillSkipCompleted = true
}
const lastValidAcoustIdClientKey = ref(
  String((runtime as any).setting.acoustIdClientKey || '').trim()
)
;(runtime as any).setting.acoustIdClientKey = lastValidAcoustIdClientKey.value
const acoustIdKeyValidating = ref(false)
const acoustIdKeyErrorText = ref('')

const AUDIO_FOLLOW_SYSTEM_ID = ''
const isWindowsPlatform = computed(() => runtime.setting.platform === 'win32')

if (runtime.setting.audioOutputDeviceId === undefined) {
  runtime.setting.audioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
}

if ((runtime as any).setting.waveformStyle === undefined) {
  ;(runtime as any).setting.waveformStyle = 'SoundCloud'
}

if ((runtime as any).setting.waveformMode === undefined) {
  ;(runtime as any).setting.waveformMode = 'half'
}
if ((runtime as any).setting.keyDisplayStyle === undefined) {
  ;(runtime as any).setting.keyDisplayStyle = 'Classic'
}

const ensurePlayerGlobalShortcuts = () => {
  if (!runtime.setting.playerGlobalShortcuts) {
    runtime.setting.playerGlobalShortcuts = {
      fastForward: 'Shift+Alt+Right',
      fastBackward: 'Shift+Alt+Left',
      nextSong: 'Shift+Alt+Down',
      previousSong: 'Shift+Alt+Up'
    }
  }
  return runtime.setting.playerGlobalShortcuts
}
ensurePlayerGlobalShortcuts()

// 将布尔设置映射为单选值（与指纹模式类似的布局与交互）
const songListBubbleMode = computed<'overflowOnly' | 'always'>({
  get() {
    return (runtime as any).setting.songListBubbleAlways ? 'always' : 'overflowOnly'
  },
  set(v) {
    ;(runtime as any).setting.songListBubbleAlways = v === 'always'
  }
})

type AudioOutputOption = {
  deviceId: string
  label: string
}
const audioOutputDevices = ref<AudioOutputOption[]>([])
const isEnumeratingAudioOutputs = ref(false)
const audioOutputError = ref<string | null>(null)
const audioOutputSupported = computed(() => {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'
  )
})
let cleanupAudioDeviceListener: (() => void) | null = null

const themeModeOptions = computed(() => [
  { label: t('theme.system'), value: 'system' },
  { label: t('theme.light'), value: 'light' },
  { label: t('theme.dark'), value: 'dark' }
])

const languageOptions = computed(() => [
  { label: '简体中文', value: 'zhCN' },
  { label: 'English', value: 'enUS' }
])

const waveformStyleOptions = computed(() => [
  { label: t('player.waveformStyleSoundCloud'), value: 'SoundCloud' },
  { label: t('player.waveformStyleFine'), value: 'Fine' },
  { label: t('player.waveformStyleRGB'), value: 'RGB' }
])

const waveformModeOptions = computed(() => [
  { label: t('player.waveformModeHalf'), value: 'half' },
  { label: t('player.waveformModeFull'), value: 'full' }
])

const keyDisplayStyleOptions = computed(() => [
  { label: t('player.keyDisplayStyleClassic'), value: 'Classic' },
  { label: t('player.keyDisplayStyleCamelot'), value: 'Camelot' }
])

const audioOutputSelectOptions = computed(() => {
  const unknownText = t('player.audioOutputDeviceUnknown')
  return [
    { label: t('player.audioOutputFollowSystem'), value: AUDIO_FOLLOW_SYSTEM_ID },
    ...audioOutputDevices.value.map((device, index) => ({
      label: device.label || `${unknownText} ${index + 1}`,
      value: device.deviceId
    }))
  ]
})

const cancel = () => {
  closeWithAnimation(() => {
    emits('cancel')
  })
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
  // 获取指纹库长度
  getSongFingerprintListLength()
  if (audioOutputSupported.value && navigator.mediaDevices) {
    const handleDeviceChange = () => {
      void refreshAudioOutputDevices()
    }
    if (typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
      cleanupAudioDeviceListener = () => {
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      }
    } else {
      const previousHandler = navigator.mediaDevices.ondevicechange
      navigator.mediaDevices.ondevicechange = handleDeviceChange
      cleanupAudioDeviceListener = () => {
        if (navigator.mediaDevices.ondevicechange === handleDeviceChange) {
          navigator.mediaDevices.ondevicechange = previousHandler || null
        } else if (!navigator.mediaDevices.ondevicechange && previousHandler) {
          navigator.mediaDevices.ondevicechange = previousHandler
        }
      }
    }
    void refreshAudioOutputDevices()
  } else {
    audioOutputDevices.value = []
    audioOutputError.value = t('player.audioOutputNotSupported')
    if (runtime.setting.audioOutputDeviceId) {
      runtime.setting.audioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
      void setSetting()
    }
  }
})

onUnmounted(() => {
  if (cleanupAudioDeviceListener) {
    cleanupAudioDeviceListener()
    cleanupAudioDeviceListener = null
  }
  utils.delHotkeysScope(uuid)
})

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  await getSongFingerprintListLength()
}

const refreshAudioOutputDevices = async () => {
  audioOutputError.value = null
  if (!audioOutputSupported.value || !navigator.mediaDevices) {
    audioOutputDevices.value = []
    audioOutputError.value = t('player.audioOutputNotSupported')
    if (runtime.setting.audioOutputDeviceId) {
      runtime.setting.audioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
      await setSetting()
    }
    return
  }
  isEnumeratingAudioOutputs.value = true
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter(
      (device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default'
    )
    audioOutputDevices.value = outputs.map((device) => ({
      deviceId: device.deviceId,
      label: device.label
    }))
    const current = runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
    if (current && !audioOutputDevices.value.some((device) => device.deviceId === current)) {
      audioOutputError.value = t('player.audioOutputDeviceUnavailable')
      runtime.setting.audioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
      await setSetting()
    }
  } catch (error) {
    const reason = String((error as any)?.message || error || '')
    audioOutputError.value = t('player.audioOutputRefreshFailed', { reason })
  } finally {
    isEnumeratingAudioOutputs.value = false
  }
}

const openAcoustIdSite = () => {
  window.electron.ipcRenderer.send('openLocalBrowser', 'https://acoustid.org/new-application')
}

const handleAcoustIdKeyBlur = async () => {
  const rawValue = runtime.setting.acoustIdClientKey || ''
  const trimmed = rawValue.trim()
  if (rawValue !== trimmed) {
    runtime.setting.acoustIdClientKey = trimmed
  }
  if (trimmed === lastValidAcoustIdClientKey.value) {
    acoustIdKeyErrorText.value = ''
    if (rawValue !== trimmed) {
      await setSetting()
    }
    return
  }
  if (!trimmed) {
    lastValidAcoustIdClientKey.value = ''
    acoustIdKeyErrorText.value = ''
    runtime.setting.acoustIdClientKey = ''
    await setSetting()
    return
  }
  acoustIdKeyValidating.value = true
  try {
    await window.electron.ipcRenderer.invoke('acoustid:validateClientKey', trimmed)
    lastValidAcoustIdClientKey.value = trimmed
    acoustIdKeyErrorText.value = ''
    runtime.setting.acoustIdClientKey = trimmed
    await setSetting()
  } catch (error: any) {
    acoustIdKeyErrorText.value = mapAcoustIdClientError(error?.message)
    runtime.setting.acoustIdClientKey = lastValidAcoustIdClientKey.value
  } finally {
    acoustIdKeyValidating.value = false
  }
}

const handleAudioOutputChange = async () => {
  audioOutputError.value = null
  runtime.setting.audioOutputDeviceId =
    runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
  await setSetting()
}

watch(
  () => runtime.setting.language,
  () => {
    if (audioOutputSupported.value) {
      void refreshAudioOutputDevices()
    }
  }
)

// 更新“最近使用歌单缓存数量”并按需截断本地缓存
const updateRecentDialogCacheMaxCount = async () => {
  runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
    0,
    Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
  )
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount
  const keys = ['FilterLibrary', 'CuratedLibrary', 'MixtapeLibrary']
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

const playerGlobalShortcutHandle = async (action: PlayerGlobalShortcutAction) => {
  ensurePlayerGlobalShortcuts()
  await playerGlobalShortcutDialog(action)
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
    cancel()
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
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      style="width: 60vw; height: 70vh; display: flex; flex-direction: column"
      class="inner"
    >
      <div style="height: 100%; display: flex; flex-direction: column">
        <div class="dialog-title dialog-header">
          <span>{{ t('common.setting') }}</span>
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
              <BaseSelect
                v-model="(runtime as any).setting.themeMode"
                :options="themeModeOptions"
                @change="setSetting"
              />
            </div>
            <div style="margin-top: 20px">{{ t('common.language') }}：</div>
            <div style="margin-top: 10px">
              <BaseSelect
                v-model="runtime.setting.language"
                :options="languageOptions"
                @change="setSetting"
              />
            </div>
            <div style="margin-top: 20px">{{ t('player.audioOutputDevice') }}：</div>
            <div style="margin-top: 10px">
              <BaseSelect
                v-model="runtime.setting.audioOutputDeviceId"
                :options="audioOutputSelectOptions"
                :disabled="!audioOutputSupported || isEnumeratingAudioOutputs"
                @change="handleAudioOutputChange"
              />
              <div v-if="audioOutputError" style="margin-top: 6px; font-size: 12px; color: #e81123">
                {{ audioOutputError }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('player.autoPlayNext') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox v-model="runtime.setting.autoPlayNextSong" @change="setSetting()" />
            </div>
            <div style="margin-top: 20px">{{ t('player.autoCenterSong') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="runtime.setting.autoScrollToCurrentSong"
                @change="setSetting()"
              />
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
            <div style="margin-top: 20px">{{ t('player.waveformStyle') }}：</div>
            <div style="margin-top: 10px">
              <BaseSelect
                v-model="(runtime as any).setting.waveformStyle"
                :options="waveformStyleOptions"
                @change="setSetting"
              />
            </div>
            <div style="margin-top: 20px">{{ t('player.waveformMode') }}：</div>
            <div style="margin-top: 10px">
              <BaseSelect
                v-model="(runtime as any).setting.waveformMode"
                :options="waveformModeOptions"
                @change="setSetting"
              />
            </div>
            <div style="margin-top: 20px">{{ t('player.keyDisplayStyle') }}：</div>
            <div style="margin-top: 10px">
              <BaseSelect
                v-model="(runtime as any).setting.keyDisplayStyle"
                :options="keyDisplayStyleOptions"
                @change="setSetting"
              />
            </div>
            <div style="margin-top: 20px">{{ t('player.showIdleAnalysisStatus') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="(runtime as any).setting.showIdleAnalysisStatus"
                @change="setSetting"
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
                :title="runtime.setting.globalCallShortcut"
                @click="globalCallShortcutHandle()"
              >
                {{ runtime.setting.globalCallShortcut }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('shortcuts.playerGlobalShortcuts') }}：</div>
            <div class="playerShortcutList">
              <div class="playerShortcutRow">
                <div class="playerShortcutLabel">
                  {{ t('shortcuts.globalFastForwardShortcut') }}
                </div>
                <div
                  class="chooseDirDiv"
                  :title="runtime.setting.playerGlobalShortcuts.fastForward"
                  @click="playerGlobalShortcutHandle('fastForward')"
                >
                  {{ runtime.setting.playerGlobalShortcuts.fastForward }}
                </div>
              </div>
              <div class="playerShortcutRow">
                <div class="playerShortcutLabel">
                  {{ t('shortcuts.globalFastBackwardShortcut') }}
                </div>
                <div
                  class="chooseDirDiv"
                  :title="runtime.setting.playerGlobalShortcuts.fastBackward"
                  @click="playerGlobalShortcutHandle('fastBackward')"
                >
                  {{ runtime.setting.playerGlobalShortcuts.fastBackward }}
                </div>
              </div>
              <div class="playerShortcutRow">
                <div class="playerShortcutLabel">{{ t('shortcuts.globalNextShortcut') }}</div>
                <div
                  class="chooseDirDiv"
                  :title="runtime.setting.playerGlobalShortcuts.nextSong"
                  @click="playerGlobalShortcutHandle('nextSong')"
                >
                  {{ runtime.setting.playerGlobalShortcuts.nextSong }}
                </div>
              </div>
              <div class="playerShortcutRow">
                <div class="playerShortcutLabel">{{ t('shortcuts.globalPreviousShortcut') }}</div>
                <div
                  class="chooseDirDiv"
                  :title="runtime.setting.playerGlobalShortcuts.previousSong"
                  @click="playerGlobalShortcutHandle('previousSong')"
                >
                  {{ runtime.setting.playerGlobalShortcuts.previousSong }}
                </div>
              </div>
            </div>
            <div class="playerShortcutHint">
              {{ t('shortcuts.playerGlobalShortcutsHint') }}
            </div>
            <div style="margin-top: 20px">{{ t('player.fastForwardTime') }}：</div>
            <div style="margin-top: 10px">
              <input
                v-model="runtime.setting.fastForwardTime"
                class="myInput"
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
                v-model="runtime.setting.fastBackwardTime"
                class="myInput"
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
            <div style="margin-top: 20px">{{ t('player.recentPlaylistCache') }}：</div>
            <div style="margin-top: 10px">
              <input
                v-model="runtime.setting.recentDialogSelectedSongListMaxCount"
                class="myInput"
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
            <div style="margin-top: 30px">
              <div class="section-title">{{ t('metadata.acoustidSettingTitle') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc1') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc2') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc3') }}</div>
              <div class="acoustid-row">
                <input
                  v-model="runtime.setting.acoustIdClientKey"
                  class="acoustid-input"
                  :class="{ invalid: acoustIdKeyErrorText }"
                  :placeholder="t('metadata.acoustidSettingPlaceholder')"
                  :disabled="acoustIdKeyValidating"
                  @blur="handleAcoustIdKeyBlur"
                />
                <div
                  class="button"
                  style="height: 25px; line-height: 25px"
                  @click="openAcoustIdSite"
                >
                  {{ t('metadata.acoustidSettingOpenLink') }}
                </div>
              </div>
              <div v-if="acoustIdKeyValidating" class="setting-hint">
                {{ t('metadata.acoustidKeyValidating') }}
              </div>
              <div v-else-if="acoustIdKeyErrorText" class="error-text">
                {{ acoustIdKeyErrorText }}
              </div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingRateHint') }}</div>
            </div>
            <div style="margin-top: 20px">{{ t('metadata.autoFillSkipCompleted') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="(runtime as any).setting.autoFillSkipCompleted"
                @change="setSetting()"
              />
            </div>
            <div class="setting-hint">{{ t('metadata.autoFillSkipCompletedHint') }}</div>
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
            <template v-if="isWindowsPlatform">
              <div style="margin-top: 20px">{{ t('settings.enableExplorerContextMenu') }}</div>
              <div style="margin-top: 10px">
                <singleCheckbox
                  v-model="(runtime as any).setting.enableExplorerContextMenu"
                  @change="setSetting()"
                />
              </div>
            </template>
            <div style="margin-top: 20px">{{ t('settings.songListBubble.title') }}：</div>
            <div style="margin-top: 10px">
              <singleRadioGroup
                v-model="songListBubbleMode as any"
                name="songListBubble"
                :options="[
                  { label: t('settings.songListBubble.overflowOnly'), value: 'overflowOnly' },
                  { label: t('settings.songListBubble.always'), value: 'always' }
                ]"
                :option-font-size="12"
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
                :max-width="220"
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
                v-model="(runtime as any).setting.fingerprintMode as any"
                name="fpMode"
                :options="[
                  { label: t('fingerprints.modePCM'), value: 'pcm' },
                  { label: t('fingerprints.modeFile'), value: 'file' }
                ]"
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
                    :max-width="360"
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
                :max-width="260"
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
        <div class="dialog-footer">
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

.setting-hint {
  font-size: 12px;
  color: var(--text-secondary, #8c8c8c);
  margin-top: 8px;
  line-height: 1.5;
}

.acoustid-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}

.acoustid-input {
  flex: 1;
  height: 25px;
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  color: var(--text);
  border-radius: 3px;
  padding: 0 8px;
  outline: none;
}

.acoustid-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
}

.acoustid-input.invalid {
  border-color: #e81123;
}

.error-text {
  color: #e81123;
  font-size: 12px;
  margin-top: 6px;
}

.playerShortcutList {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.playerShortcutRow {
  display: flex;
  align-items: center;
  gap: 10px;
}

.playerShortcutLabel {
  min-width: 130px;
  font-size: 13px;
  color: var(--text-weak);
}

.playerShortcutHint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-weak);
}
</style>
