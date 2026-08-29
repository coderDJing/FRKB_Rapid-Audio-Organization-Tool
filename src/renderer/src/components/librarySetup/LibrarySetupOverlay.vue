<script setup lang="ts">
import { computed, reactive, ref, type ComponentPublicInstance } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import welcomeLogoAsset from '@renderer/assets/welcomeLogo.png?asset'
import { useLibrarySetupWizard } from '@renderer/composables/useLibrarySetupWizard'

const runtime = useRuntimeStore()
const flashArea = ref('')
const hintIcon = hintIconAsset
const welcomeLogo = welcomeLogoAsset
const optionHintRefs = reactive<Record<string, HTMLElement | null>>({})
const resolveTemplateElement = (
  value: Element | ComponentPublicInstance | null
): HTMLElement | null => {
  if (value instanceof HTMLElement) return value
  if (!value || typeof value !== 'object' || !('$el' in value)) return null
  return value.$el instanceof HTMLElement ? value.$el : null
}
const setOptionHintRef = (value: string, el: Element | ComponentPublicInstance | null) => {
  optionHintRefs[value] = resolveTemplateElement(el)
}

const {
  step,
  folderPathVal,
  dbName,
  targetDir,
  fingerprintModeModel,
  manifestDisplayName,
  submitting,
  clickChooseDir,
  clickChooseExistingDb,
  submitCreate,
  goCreate,
  goExisting,
  goBack,
  goNextFromPath,
  cancelOrExit
} = useLibrarySetupWizard(flashArea)

const cardTitle = computed(() => {
  if (runtime.librarySetupMode === 'reselect') return t('database.reselectLocation')
  if (step.value === 'create-path') return t('database.createNewDb')
  if (step.value === 'create-fingerprint') return t('fingerprints.mode')
  if (step.value === 'existing') return t('database.chooseExistingDb')
  return t('database.selectLocation')
})
const cardSubtitle = computed(() => {
  if (step.value === 'choice') return t('database.notConfigured')
  if (step.value === 'create-path') return t('database.initHintCreate')
  if (step.value === 'create-fingerprint') return t('fingerprints.modeIncompatibleWarning')
  return t('database.existingHint')
})
const footerExitLabel = computed(() =>
  runtime.librarySetupMode === 'reselect' ? t('common.cancel') : t('menu.exit')
)
const fingerprintOptions = computed(() => [
  { label: t('fingerprints.modePCM'), value: 'pcm' },
  { label: t('fingerprints.modeFile'), value: 'file' }
])
</script>

<template>
  <div class="library-setup-overlay unselectable">
    <div class="library-setup-panel" :class="{ 'is-busy': submitting }">
      <img
        class="library-setup-logo theme-icon"
        :src="welcomeLogo"
        width="72"
        height="72"
        alt=""
        draggable="false"
      />
      <div class="library-setup-title">{{ cardTitle }}</div>
      <p class="library-setup-line">{{ cardSubtitle }}</p>

      <div v-if="step === 'choice'" class="library-setup-body">
        <div class="library-setup-choices">
          <button class="library-setup-choice" type="button" @click="goCreate()">
            <span class="library-setup-choice__title">{{ t('database.createNewDb') }}</span>
            <span class="library-setup-choice__desc">{{ t('database.initHintCreate') }}</span>
          </button>
          <button class="library-setup-choice" type="button" @click="goExisting()">
            <span class="library-setup-choice__title">{{ t('database.chooseExistingDb') }}</span>
            <span class="library-setup-choice__desc">{{
              t('database.initHintExisting', { manifestName: manifestDisplayName })
            }}</span>
          </button>
        </div>
        <div class="library-setup-actions">
          <div class="button" @click="cancelOrExit()">{{ footerExitLabel }} (Esc)</div>
        </div>
      </div>

      <div v-else-if="step === 'existing'" class="library-setup-body">
        <button class="library-setup-choice" type="button" @click="clickChooseExistingDb()">
          <span class="library-setup-choice__title">{{ t('database.pickManifestFile') }}</span>
          <span class="library-setup-choice__desc">{{
            t('database.initHintExisting', { manifestName: manifestDisplayName })
          }}</span>
        </button>
        <div class="library-setup-actions">
          <div class="button" @click="goBack()">{{ t('common.back') }}</div>
        </div>
      </div>

      <div v-else-if="step === 'create-path'" class="library-setup-body">
        <div class="library-setup-field">
          <div class="library-setup-label">{{ t('database.pickFolder') }}</div>
          <bubbleBoxTrigger
            class="library-setup-path-btn flashing-border"
            :title="folderPathVal"
            :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
            @click="clickChooseDir()"
          >
            {{ folderPathVal || t('database.pickFolder') }}
          </bubbleBoxTrigger>
        </div>
        <div class="library-setup-field">
          <div class="library-setup-label">{{ t('database.inputDbName') }}</div>
          <input
            v-model="dbName"
            class="library-setup-input flashing-border"
            :class="{ 'is-flashing': flashArea == 'dbName' }"
            :placeholder="t('database.inputDbNamePlaceholder')"
          />
        </div>
        <bubbleBoxTrigger
          v-if="targetDir"
          class="library-setup-hint library-setup-hint--path"
          :title="targetDir"
          :max-width="520"
          :only-when-overflow="true"
        >
          {{ t('database.initTargetPath', { path: targetDir }) }}
        </bubbleBoxTrigger>
        <div class="library-setup-hint">{{ t('database.storageHint') }}</div>
        <div class="library-setup-actions">
          <div class="button" @click="goBack()">{{ t('common.back') }}</div>
          <div class="button" @click="goNextFromPath()">{{ t('common.next') }}</div>
        </div>
      </div>

      <div v-else class="library-setup-body">
        <div class="flashing-border" :class="{ 'is-flashing': flashArea == 'fingerprintMode' }">
          <singleRadioGroup
            v-model="fingerprintModeModel"
            name="librarySetupFingerprintMode"
            :options="fingerprintOptions"
          >
            <template #option="{ opt }">
              <span class="label">{{ opt.label }}</span>
              <img
                :ref="(el) => setOptionHintRef(opt.value, el)"
                :src="hintIcon"
                class="library-setup-hint-icon theme-icon"
                :draggable="false"
                alt=""
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
        <div class="library-setup-actions">
          <div class="button" @click="goBack()">{{ t('common.back') }}</div>
          <div class="button" @click="submitCreate()">{{ t('common.confirm') }} (E)</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.library-setup-overlay {
  position: fixed;
  top: 35px;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: var(--z-library-setup-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: var(--user-guide-mask);
  backdrop-filter: blur(3px);
}

.library-setup-panel {
  width: min(640px, 100%);
  padding: 28px 28px 24px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 12px;
  background: var(--user-guide-panel);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.library-setup-panel.is-busy {
  pointer-events: none;
  opacity: 0.72;
}

.library-setup-logo {
  width: 72px;
  height: 72px;
  object-fit: contain;
}

.library-setup-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  text-align: center;
}

.library-setup-line {
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-weak);
  text-align: center;
}

.library-setup-body {
  width: 100%;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.library-setup-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.library-setup-choice {
  appearance: none;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 132px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.library-setup-choice:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.library-setup-choice__title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.library-setup-choice__desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-weak);
}

.library-setup-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.library-setup-label {
  font-size: 14px;
  color: var(--text);
}

.library-setup-path-btn,
.library-setup-input {
  width: 100%;
  height: 25px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 14px;
  line-height: 25px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-setup-path-btn {
  cursor: pointer;
}

.library-setup-path-btn:hover {
  background-color: var(--hover);
  border-color: var(--accent);
}

.library-setup-input {
  outline: none;

  &::placeholder {
    color: var(--text-weak);
  }

  &:focus {
    border-color: var(--accent);
  }
}

.library-setup-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-weak);
}

.library-setup-hint--path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}

.library-setup-hint-icon {
  width: 14px;
  height: 14px;
  margin-left: 6px;
}

.library-setup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 4px;
}

.library-setup-actions .button {
  min-width: 90px;
  text-align: center;
}
</style>
