<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'

const props = defineProps<{
  confirmCallback?: (payload: any) => void
  cancelCallback?: () => void
  sourceExts?: string[]
}>()
const uuid = uuidV4()

type ConvertDefaults = {
  targetFormat: 'mp3' | 'flac' | 'wav' | 'aif' | 'aiff'
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

const supportedFormats = ref<Array<ConvertDefaults['targetFormat']>>([
  'mp3',
  'flac',
  'wav',
  'aif',
  'aiff'
])
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

// 当目标格式不是 MP3/FLAC 时，强制关闭“保留元数据”
watch(
  () => form.value.targetFormat,
  (fmt) => {
    if (fmt !== 'mp3' && fmt !== 'flac') {
      form.value.preserveMetadata = false
    }
  }
)

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
    const audioExt: string[] = Array.isArray(setting?.audioExt) ? setting.audioExt : []
    const set = new Set(audioExt.map((e) => String(e || '').toLowerCase()))
    const map: Record<string, ConvertDefaults['targetFormat']> = {
      '.mp3': 'mp3',
      '.flac': 'flac',
      '.wav': 'wav',
      '.aif': 'aif',
      '.aiff': 'aiff'
    }
    let allowed = (Object.keys(map) as Array<keyof typeof map>)
      .filter((k) => set.has(k))
      .map((k) => map[k])
    if (allowed.length === 0) allowed = ['mp3', 'flac', 'wav']

    // 过滤与源相同的格式（简单化：移除所有所选文件扩展名对应的目标格式）
    const srcSet = new Set(
      (props.sourceExts || [])
        .map((e) => String(e || '').toLowerCase())
        .map((e) => map[e])
        .filter(Boolean) as Array<ConvertDefaults['targetFormat']>
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
  } catch {}
  if (setting?.convertDefaults) {
    form.value = { ...form.value, ...setting.convertDefaults }
  }
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

const confirm = async () => {
  // 校验：目标格式必选且在可选列表中
  if (!supportedFormats.value.includes(form.value.targetFormat as any)) {
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

          <div
            v-if="form.targetFormat === 'mp3' || form.targetFormat === 'flac'"
            style="margin-top: 20px"
          >
            {{ t('convert.preserveMetadata') }}：
          </div>
          <div
            v-if="form.targetFormat === 'mp3' || form.targetFormat === 'flac'"
            style="margin-top: 10px"
          >
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
