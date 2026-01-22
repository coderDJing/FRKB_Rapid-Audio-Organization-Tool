<script setup lang="ts">
import { ref, onMounted, onUnmounted, useTemplateRef } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import { CONTACT_EMAIL } from '../constants/app'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const hintIcon = hintIconAsset
const emits = defineEmits(['cancel'])
const uuid = uuidV4()

const userKey = ref('')
const connectivity = ref<null | { success: boolean; message?: string }>(null)
const limitInfo = ref<null | { success: boolean; limit?: number; message?: string }>(null)
const testing = ref(false)
const saving = ref(false)
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const cancel = () => {
  closeWithAnimation(() => emits('cancel'))
}

const clickTest = async () => {
  if (testing.value) return
  testing.value = true
  try {
    const res = await window.electron.ipcRenderer.invoke('cloudSync/testConnectivity', {
      userKey: userKey.value
    })
    connectivity.value = res
    // 连通成功后直接使用返回的 limit（后端已支持）
    limitInfo.value = res?.success ? { success: true, limit: Number(res?.limit) } : null
  } finally {
    testing.value = false
  }
}

const clickSave = async () => {
  if (saving.value) return
  saving.value = true
  try {
    const res = await window.electron.ipcRenderer.invoke('cloudSync/config/save', {
      userKey: userKey.value
    })
    if (res?.success) {
      cancel()
    } else {
      // 显示内联错误
      connectivity.value = {
        success: false,
        message: res?.message || 'cloudSync.connectivityFailed'
      }
    }
  } finally {
    saving.value = false
  }
}

const clickCopyEmail = async () => {
  await navigator.clipboard.writeText(CONTACT_EMAIL)
}
// 提示气泡：申请/找回说明（统一到 bubbleBox）
const emailHintIconRef = useTemplateRef<HTMLImageElement>('emailHintIconRef')

onMounted(async () => {
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  userKey.value = cfg?.userKey || ''
  hotkeys('E,Enter', uuid, () => {
    void clickSave()
  })
  hotkeys('T', uuid, () => {
    void clickTest()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => utils.delHotkeysScope(uuid))
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="title dialog-title dialog-header">{{ t('cloudSync.settings') }}</div>
      <div class="body">
        <div class="form">
          <div class="row">
            <div class="label">{{ t('cloudSync.userKey') }}</div>
            <input v-model="userKey" class="input" placeholder="uuid-v4" style="max-width: 100%" />
          </div>
          <div class="row" style="position: relative">
            <div class="label">{{ t('cloudSync.applyEmailHint') }}</div>
            <div
              class="value"
              style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap"
            >
              <span>{{ CONTACT_EMAIL }}</span>
              <span class="link" @click="clickCopyEmail">{{ t('cloudSync.copyEmail') }}</span>
              <img
                ref="emailHintIconRef"
                :src="hintIcon"
                style="width: 14px; height: 14px; margin-top: 2px"
                :draggable="false"
                class="theme-icon"
              />
              <bubbleBox
                :dom="emailHintIconRef || undefined"
                :title="t('cloudSync.applyEmailInstruction')"
                :maxWidth="320"
              />
            </div>
          </div>
          <div class="row">
            <div class="label">{{ t('cloudSync.connectivity') }}</div>
            <div class="value">
              <span v-if="connectivity === null">{{ t('cloudSync.notTested') }}</span>
              <span v-else-if="connectivity.success" class="success">
                {{ t('cloudSync.connectivityOk') }}
                <template v-if="limitInfo && typeof limitInfo.limit === 'number'">
                  <span class="sep">|</span>
                  <span class="muted">{{ t('cloudSync.limit') }}: {{ limitInfo.limit }}</span>
                </template>
              </span>
              <span v-else class="error">{{
                t(connectivity.message || 'cloudSync.connectivityFailed')
              }}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div
          class="button"
          style="width: 120px; text-align: center; height: 25px; line-height: 25px"
          @click="clickTest"
        >
          {{ t('cloudSync.testConnectivity') }} (T)
        </div>
        <div
          class="button"
          style="width: 120px; text-align: center; height: 25px; line-height: 25px"
          @click="clickSave"
        >
          {{ t('common.save') }} (E)
        </div>
        <div
          class="button"
          style="width: 120px; text-align: center; height: 25px; line-height: 25px"
          @click="cancel"
        >
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.title {
  color: var(--text);
}
.body {
  padding: 20px 28px 20px 20px;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.label {
  font-size: 12px;
  text-align: left;
  color: var(--text-weak);
  line-height: 1.3;
  word-break: break-word;
}
.input {
  width: 100%;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 8px;
  border-radius: 4px;
}
.input::placeholder {
  color: var(--text-weak);
}
.input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
}
.value {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  flex-wrap: wrap;
}
.value .sep {
  margin: 0 6px;
  color: var(--text-weak);
}
.value .muted {
  color: var(--text-weak);
}
.link {
  color: var(--accent);
  cursor: pointer;
}
.error {
  color: #e81123;
}
.success {
  color: #107c10;
}
</style>
