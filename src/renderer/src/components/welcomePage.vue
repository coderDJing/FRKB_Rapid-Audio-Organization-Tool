<script setup lang="ts">
import welcomeLogo from '@renderer/assets/welcomeLogo.png?asset'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { computed } from 'vue'

const runtime = useRuntimeStore()

// 将快捷键字符串转换为数组
const globalShortcut = computed(() => {
  return runtime.setting.globalCallShortcut.split('+').map((key) => ({
    key,
    needSeparator: true
  }))
})
</script>

<template>
  <div class="welcome-container">
    <div class="welcome-content">
      <img
        :src="welcomeLogo"
        width="150"
        height="150"
        alt=""
        class="unselectable welcome-logo theme-icon"
        draggable="false"
      />
      <div class="shortcuts">
        <dl>
          <dt>{{ t('player.playPause') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">Space</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('player.previousNext') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">W / S</span>
              <span class="easter-egg">( ↑ / ↓ )</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('player.fastBackwardForward') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">A / D</span>
              <span class="easter-egg">( ← / → )</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('shortcuts.globalPreviousNext') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">Shift</span>
              <span class="monaco-keybinding-key-separator">+</span>
              <span class="monaco-keybinding-key">Alt</span>
              <span class="monaco-keybinding-key-separator">+</span>
              <span class="monaco-keybinding-key">Up / Down</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('shortcuts.globalFastBackwardForward') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">Shift</span>
              <span class="monaco-keybinding-key-separator">+</span>
              <span class="monaco-keybinding-key">Alt</span>
              <span class="monaco-keybinding-key-separator">+</span>
              <span class="monaco-keybinding-key">Left / Right</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('player.moveToLibraries') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">Q / E</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('common.delete') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">F</span>
              <span class="easter-egg">( Delete )</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('player.playbackRange') }}</dt>
          <dd>
            <div class="monaco-keybinding">
              <span class="monaco-keybinding-key">R</span>
            </div>
          </dd>
        </dl>
        <dl>
          <dt>{{ t('player.showHide') }}</dt>
          <dd>
            <div class="monaco-keybinding" style="min-width: 250px">
              <template v-for="(item, index) in globalShortcut" :key="index">
                <span class="monaco-keybinding-key">{{ item.key }}</span>
                <span
                  v-if="index !== globalShortcut.length - 1"
                  class="monaco-keybinding-key-separator"
                  >+</span
                >
              </template>
            </div>
          </dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.welcome-container {
  width: 430px;
  padding: 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-weak);
  flex-shrink: 0;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-weak);
  width: 430px;
  flex-shrink: 0;
}

.welcome-logo {
  width: 150px;
  height: 150px;
  flex-shrink: 0;
}

.shortcuts {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

dl {
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  align-items: center;
  min-width: 0;

  &:last-child {
    margin-bottom: 0;
  }
}

dt {
  font-size: 14px;
  text-align: right;
  width: 220px;
  padding-right: 10px;
  flex-shrink: 0;
  box-sizing: border-box;
  white-space: normal;
  line-height: 1.4;
}

dd {
  margin: 0;
  text-align: left;
  width: 160px;
  flex-shrink: 0;
  box-sizing: border-box;
}

.monaco-keybinding {
  display: flex;
  align-items: center;
  position: relative;
  min-width: 0;

  .easter-egg {
    margin-left: 8px;
    color: var(--text);
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.3s ease;
    white-space: nowrap;
  }

  &:hover {
    .easter-egg {
      opacity: 1;
    }
  }
}

.monaco-keybinding-key {
  padding: 4px 8px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-bottom-color: var(--border);
  box-shadow: inset 0 -1px 0 var(--border);
  border-radius: 3px;
  font-size: 11px;
  min-width: 60px;
  display: inline-flex;
  justify-content: center;
  text-align: center;
  color: var(--text-weak);
  white-space: nowrap;
}

.monaco-keybinding-key-separator {
  padding: 0 4px;
  color: var(--text-weak);
}

.global-shortcut-divider {
  color: var(--text-weak);
  font-size: 13px;
}

.unselectable {
  user-select: none;
  -webkit-user-drag: none;
}
</style>
