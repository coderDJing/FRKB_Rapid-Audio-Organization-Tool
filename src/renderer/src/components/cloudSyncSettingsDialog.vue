<script setup lang="ts">
import { ref, onMounted, onUnmounted, useTemplateRef } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import hintIcon from '@renderer/assets/hint.png?asset'
import { CONTACT_EMAIL } from '../constants/app'
import bubbleBox from '@renderer/components/bubbleBox.vue'
const emits = defineEmits(['cancel'])
const uuid = uuidV4()

const userKey = ref('')
const connectivity = ref<null | { success: boolean; message?: string }>(null)
const limitInfo = ref<null | { success: boolean; limit?: number; message?: string }>(null)
const testing = ref(false)
const saving = ref(false)

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
      emits('cancel')
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
  hotkeys('E', uuid, () => {
    void clickSave()
  })
  hotkeys('T', uuid, () => {
    void clickTest()
  })
  hotkeys('Esc', uuid, () => {
    emits('cancel')
    return false
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => utils.delHotkeysScope(uuid))
</script>

<template>
  <div class="dialog unselectable">
    <div class="inner">
      <div class="title">{{ t('cloudSync.settings') }}</div>
      <div class="form">
        <div class="row">
          <div class="label">{{ t('cloudSync.userKey') }}</div>
          <input v-model="userKey" class="input" placeholder="uuid-v4" style="max-width: 100%" />
        </div>
        <div class="row" style="position: relative">
          <div class="label">{{ t('cloudSync.applyEmailHint') }}</div>
          <div class="value" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <span>{{ CONTACT_EMAIL }}</span>
            <span class="link" @click="clickCopyEmail">{{ t('cloudSync.copyEmail') }}</span>
            <img
              ref="emailHintIconRef"
              :src="hintIcon"
              style="width: 14px; height: 14px; margin-top: 2px"
              :draggable="false"
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
      <div class="actions">
        <div
          class="button"
          style="
            margin-right: 10px;
            width: 120px;
            text-align: center;
            height: 25px;
            line-height: 25px;
          "
          @click="clickTest"
        >
          {{ t('cloudSync.testConnectivity') }} (T)
        </div>
        <div
          class="button"
          style="
            margin-right: 10px;
            width: 120px;
            text-align: center;
            height: 25px;
            line-height: 25px;
          "
          @click="clickSave"
        >
          {{ t('common.save') }} (E)
        </div>
        <div
          class="button"
          style="width: 120px; text-align: center; height: 25px; line-height: 25px"
          @click="$emit('cancel')"
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
  padding: 20px 28px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.title {
  text-align: center;
  font-weight: bold;
  color: #e5e5e5;
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
  color: #bdbdbd;
  line-height: 1.3;
  word-break: break-word;
}
.input {
  width: 100%;
  background: #202020;
  border: 1px solid #2c2c2c;
  color: #e0e0e0;
  padding: 6px 8px;
  border-radius: 4px;
}
.input:focus {
  outline: none;
  border-color: #3a7afe;
}
.value {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #d0d0d0;
  flex-wrap: wrap;
}
.value .sep {
  margin: 0 6px;
  color: #5a5a5a;
}
.value .muted {
  color: #a8a8a8;
}
.link {
  color: #4da3ff;
  cursor: pointer;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 0;
  padding-top: 12px;
}
.error {
  color: #ff6b6b;
}
.success {
  color: #9fe870;
}
</style>
