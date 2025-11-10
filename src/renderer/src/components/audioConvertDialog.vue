<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import {
  SUPPORTED_AUDIO_FORMATS,
  type SupportedAudioFormat,
  METADATA_PRESERVABLE_FORMATS
} from '../../../shared/audioFormats'

const props = defineProps<{
  confirmCallback?: (payload: any) => void
  cancelCallback?: () => void
  sourceExts?: string[]
}>()
const uuid = uuidV4()

const isSupportedAudioFormat = (fmt: string): fmt is SupportedAudioFormat =>
  (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(fmt)

type ConvertDefaults = {
  targetFormat: SupportedAudioFormat
  bitrateKbps?: number
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  preserveMetadata?: boolean
  normalize?: boolean
  strategy: 'new_file' | 'replace'
  overwrite?: boolean
  backupOnReplace?: boolean
  addFingerprint?: boolean
}

const supportedFormats = ref<SupportedAudioFormat[]>([])
const form = ref<ConvertDefaults>({
  targetFormat: 'mp3',
  bitrateKbps: 320,
  sampleRate: 44100,
  channels: 2,
  preserveMetadata: true,
  normalize: false,
  strategy: 'new_file',
  overwrite: false,
  backupOnReplace: true,
  addFingerprint: false
})

// 依据容器/编码支持情况，尽量保留元数据；无法保留时 FFmpeg 会忽略
const metadataCapableFormats = new Set<SupportedAudioFormat>(METADATA_PRESERVABLE_FORMATS)
const showMetadataOption = computed(() => metadataCapableFormats.has(form.value.targetFormat))

// 必填闪烁提示（参考项目其他弹窗）
const flashArea = ref('')
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}

onMounted(async () => {
  hotkeys('E,Enter', uuid, () => {
    confirm()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)

  const setting = await window.electron.ipcRenderer.invoke('getSetting')
  try {
    // 询问主进程：FFmpeg 可编码的目标格式
    const targetFormats: string[] = await window.electron.ipcRenderer.invoke(
      'audio:convert:list-target-formats'
    )
    let allowed = targetFormats.filter(isSupportedAudioFormat)

    // 过滤与源相同的格式（简单化：移除所有所选文件扩展名对应的目标格式）
    const srcSet = new Set(
      (props.sourceExts || [])
        .map((e) => String(e || '').toLowerCase())
        .map((e) => e.replace(/^\./, ''))
        .filter(Boolean) as Array<string>
    )
    let filtered = allowed
    if (srcSet.size === 1) {
      const only = Array.from(srcSet)[0]
      filtered = allowed.filter((fmt) => {
        // .aif 与 .aiff 视为同类
        if (only === 'aif' || only === 'aiff') {
          return !(fmt === 'aif' || fmt === 'aiff')
        }
        return fmt !== only
      })
      if (filtered.length === 0) filtered = allowed
    }
    supportedFormats.value = filtered
  } catch (err) {
    console.error('[AudioConvertDialog] list-target-formats failed:', err)
  }
  if (setting?.convertDefaults) {
    const persisted = setting.convertDefaults
    const next: Partial<ConvertDefaults> = { ...persisted }
    if (next.targetFormat && !isSupportedAudioFormat(next.targetFormat)) {
      delete next.targetFormat
    }
    form.value = { ...form.value, ...next }
  }
  if (
    supportedFormats.value.length > 0 &&
    !supportedFormats.value.includes(form.value.targetFormat)
  ) {
    form.value.targetFormat = supportedFormats.value[0]
  }
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

watch(
  () => form.value.targetFormat,
  (fmt) => {
    if (!metadataCapableFormats.has(fmt)) {
      form.value.preserveMetadata = false
    }
  }
)

const confirm = async () => {
  console.log('[AudioConvertDialog] confirm clicked', { targetFormat: form.value.targetFormat })
  // 校验：目标格式必选且在可选列表中
  if (!supportedFormats.value.includes(form.value.targetFormat)) {
    if (!flashArea.value) flashBorder('targetFormat')
    return
  }
  try {
    const setting = await window.electron.ipcRenderer.invoke('getSetting')
    const next = { ...setting, convertDefaults: { ...form.value } }
    await window.electron.ipcRenderer.invoke('setSetting', next)
  } catch {}
  props.confirmCallback?.({ ...form.value })
}
const cancel = () => props.cancelCallback?.()
</script>

<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 500px;
        height: 400px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
      v-dialog-drag="'.dialog-title'"
    >
      <div>
        <div
          class="dialog-title"
          style="text-align: center; height: 30px; line-height: 30px; font-size: 14px"
        >
          <span style="font-weight: bold">{{ t('convert.title') }}</span>
        </div>
        <div style="padding: 20px; font-size: 14px">
          <div>{{ t('convert.targetFormat') }}：</div>
          <div style="margin-top: 10px">
            <select
              v-model="form.targetFormat"
              style="width: 200px"
              class="flashing-border"
              :class="{ 'is-flashing': flashArea == 'targetFormat' }"
            >
              <option v-for="fmt in supportedFormats" :key="fmt" :value="fmt">
                {{ fmt.toUpperCase() }}
              </option>
            </select>
          </div>

          <div style="margin-top: 20px">{{ t('convert.strategy') }}：</div>
          <div style="margin-top: 10px">
            <singleRadioGroup
              name="convertStrategy"
              :options="[
                { label: t('convert.newFile'), value: 'new_file' },
                { label: t('convert.replaceOriginal'), value: 'replace' }
              ]"
              v-model="(form as any).strategy"
              :optionFontSize="12"
            />
          </div>

          <div v-if="showMetadataOption" style="margin-top: 20px">
            {{ t('convert.preserveMetadata') }}：
          </div>
          <div v-if="showMetadataOption" style="margin-top: 10px">
            <singleCheckbox v-model="(form as any).preserveMetadata" />
          </div>

          <div style="margin-top: 20px">{{ t('convert.addFingerprint') }}：</div>
          <div style="margin-top: 10px">
            <singleCheckbox v-model="(form as any).addFingerprint" />
          </div>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px; height: 30px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" @click="cancel()" style="width: 90px; text-align: center">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.formLabel {
  text-align: left;
  font-size: 14px;
  width: 140px;
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

option {
  padding: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
}
</style>
