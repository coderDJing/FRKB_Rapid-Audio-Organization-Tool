<script setup lang="ts">
import welcomeLogo from '@renderer/assets/welcomeLogo.png?asset'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { computed, ref } from 'vue'

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
    <img
      :src="welcomeLogo"
      width="250"
      height="250"
      alt=""
      class="unselectable"
      draggable="false"
    />
    <div class="shortcuts">
      <dl>
        <dt>{{ t('播放 / 暂停') }}</dt>
        <dd>
          <div class="monaco-keybinding">
            <span class="monaco-keybinding-key">Space</span>
          </div>
        </dd>
      </dl>
      <dl>
        <dt>{{ t('上一首 / 下一首') }}</dt>
        <dd>
          <div class="monaco-keybinding">
            <span class="monaco-keybinding-key">W / S</span>
            <span class="easter-egg">( ↑ / ↓ )</span>
          </div>
        </dd>
      </dl>
      <dl>
        <dt>{{ t('快进 / 快退') }}</dt>
        <dd>
          <div class="monaco-keybinding">
            <span class="monaco-keybinding-key">D / A</span>
            <span class="easter-egg">( ← / → )</span>
          </div>
        </dd>
      </dl>
      <dl>
        <dt>{{ t('移动至筛选库 / 精选库') }}</dt>
        <dd>
          <div class="monaco-keybinding">
            <span class="monaco-keybinding-key">Q / E</span>
          </div>
        </dd>
      </dl>
      <dl>
        <dt>{{ t('删除') }}</dt>
        <dd>
          <div class="monaco-keybinding">
            <span class="monaco-keybinding-key">F</span>
            <span class="easter-egg">( Delete )</span>
          </div>
        </dd>
      </dl>
      <dl>
        <dt>{{ t('呼出 / 隐藏') }}</dt>
        <dd>
          <div class="monaco-keybinding">
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
</template>

<style lang="scss" scoped>
.welcome-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px;
  color: #727272;
}

.shortcuts {
  width: 100%;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

dl {
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  white-space: nowrap;

  &:last-child {
    margin-bottom: 0;
  }
}

dt {
  font-size: 14px;
  text-align: right;
  width: 220px;
  margin-right: 10px;
}

dd {
  margin: 0;
  text-align: left;
  width: 160px;
}

.monaco-keybinding {
  display: flex;
  align-items: center;
  position: relative;

  .easter-egg {
    margin-left: 8px;
    color: #fff;
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  &:hover {
    .easter-egg {
      opacity: 1;
    }
  }
}

.monaco-keybinding-key {
  padding: 4px 8px;
  background-color: #3c3c3c;
  border: 1px solid #3c3c3c;
  border-bottom-color: #1e1e1e;
  box-shadow: inset 0 -1px 0 #1e1e1e;
  border-radius: 3px;
  font-size: 11px;
  min-width: 14px;
  text-align: center;
  color: #a9a9a9;
}

.monaco-keybinding-key-separator {
  padding: 0 4px;
  color: #a9a9a9;
}

.unselectable {
  user-select: none;
  -webkit-user-drag: none;
}

.easter-egg {
  margin-left: 8px;
  color: #fff;
  font-size: 11px;
}
</style>
