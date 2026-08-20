<script setup lang="ts">
import welcomeLogoAsset from '@renderer/assets/welcomeLogo.png?asset'
import { t } from '@renderer/utils/translate'
import type { UserGuideAudience } from '@shared/userGuide'

const emit = defineEmits<{
  select: [audience: UserGuideAudience]
}>()

const welcomeLogo = welcomeLogoAsset
</script>

<template>
  <div class="user-guide-identity-mask unselectable">
    <div class="user-guide-identity-shell">
      <img
        class="user-guide-identity-logo theme-icon"
        :src="welcomeLogo"
        width="72"
        height="72"
        alt=""
        draggable="false"
      />
      <div class="user-guide-identity-title">{{ t('userGuide.identity.welcome') }}</div>
      <p class="user-guide-identity-line">{{ t('userGuide.identity.line1') }}</p>
      <p class="user-guide-identity-line">{{ t('userGuide.identity.line2') }}</p>
      <div class="user-guide-identity-actions">
        <button
          class="user-guide-identity-choice"
          type="button"
          @click="emit('select', 'rekordbox')"
        >
          <span class="user-guide-identity-choice__title">{{
            t('userGuide.identity.rekordbox')
          }}</span>
          <span class="user-guide-identity-choice__desc">{{
            t('userGuide.identity.rekordboxDesc')
          }}</span>
        </button>
        <button class="user-guide-identity-choice" type="button" @click="emit('select', 'general')">
          <span class="user-guide-identity-choice__title">{{
            t('userGuide.identity.general')
          }}</span>
          <span class="user-guide-identity-choice__desc">{{
            t('userGuide.identity.generalDesc')
          }}</span>
        </button>
        <button
          class="user-guide-identity-choice user-guide-identity-choice--quiet"
          type="button"
          @click="emit('select', 'veteran')"
        >
          <span class="user-guide-identity-choice__title">{{
            t('userGuide.identity.veteran')
          }}</span>
          <span class="user-guide-identity-choice__desc">{{
            t('userGuide.identity.veteranDesc')
          }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.user-guide-identity-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: var(--user-guide-mask);
  backdrop-filter: blur(3px);
}

.user-guide-identity-shell {
  width: min(880px, 100%);
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

.user-guide-identity-logo {
  width: 72px;
  height: 72px;
  object-fit: contain;
}

.user-guide-identity-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  text-align: center;
}

.user-guide-identity-line {
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-weak);
  text-align: center;
}

.user-guide-identity-actions {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.user-guide-identity-choice {
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

.user-guide-identity-choice:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.user-guide-identity-choice--quiet {
  opacity: 0.92;
}

.user-guide-identity-choice__title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.user-guide-identity-choice__desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-weak);
}
</style>
