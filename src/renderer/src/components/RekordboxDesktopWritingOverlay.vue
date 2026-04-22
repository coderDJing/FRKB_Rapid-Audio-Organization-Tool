<script setup lang="ts">
import { t } from '@renderer/utils/translate'
</script>

<template>
  <div class="writingMask">
    <div class="writingCard">
      <span class="writingSpinner"></span>
      <span>{{ t('rekordboxDesktop.writingInProgress') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.writingMask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(1px);
}

.writingCard {
  min-width: 150px;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--bg-elev) 92%, var(--accent) 8%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text);
  font-size: 13px;
}

.writingSpinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: rekordbox-writing-spin 0.8s linear infinite;
}

@keyframes rekordbox-writing-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
