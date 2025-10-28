<script setup lang="ts">
import listGrey from '@renderer/assets/list-grey.png?asset'
import listWhite from '@renderer/assets/list-white.png?asset'
import likeGrey from '@renderer/assets/like-grey.png?asset'
import likeWhite from '@renderer/assets/like-white.png?asset'
import settingGrey from '@renderer/assets/setting-grey.png?asset'
import settingWhite from '@renderer/assets/setting-white.png?asset'
import trashGrey from '@renderer/assets/trash-grey.png?asset'
import trashWhite from '@renderer/assets/trash-white.png?asset'
import { ref, reactive } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import settingDialog from '@renderer/components/settingDialog.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import { Icon } from '../../../../types/globals'
const emit = defineEmits(['librarySelectedChange'])

const iconArr = ref<Icon[]>([
  {
    name: 'FilterLibrary',
    grey: listGrey,
    white: listWhite,
    src: listGrey,
    showAlt: false,
    // i18n key for tooltip
    i18nKey: 'library.filter'
  } as any,
  {
    name: 'CuratedLibrary',
    grey: likeGrey,
    white: likeWhite,
    src: likeGrey,
    showAlt: false,
    i18nKey: 'library.curated'
  } as any,
  {
    name: 'RecycleBin',
    grey: trashGrey,
    white: trashWhite,
    src: trashGrey,
    showAlt: false,
    i18nKey: 'recycleBin.recycleBin'
  } as any
])

const selectedIcon = ref(iconArr.value[0])
selectedIcon.value.src = selectedIcon.value.white

const runtime = useRuntimeStore()

const clickIcon = (item: Icon) => {
  if (item.name == selectedIcon.value.name) {
    return
  }
  runtime.libraryAreaSelected = item.name
  selectedIcon.value.src = selectedIcon.value.grey
  selectedIcon.value = item
  selectedIcon.value.src = selectedIcon.value.white
}

const settingDialogShow = ref(false)
const clickButtomIcon = (item: ButtomIcon) => {
  if (item.name == '设置') {
    settingDialogShow.value = true
  }
}
const iconRefMap = reactive<Record<string, HTMLElement | null>>({})
const setIconRef = (name: string, el: Element | ComponentPublicInstance | null) => {
  let dom: HTMLElement | null = null
  if (el) {
    if (el instanceof HTMLElement) {
      dom = el
    } else if ((el as any).$el instanceof HTMLElement) {
      dom = (el as any).$el as HTMLElement
    }
  }
  iconRefMap[name] = dom
}
const iconMouseover = (item: Icon | ButtomIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.white
  }
}
const iconMouseout = (item: Icon | ButtomIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.grey
  }
}
type ButtomIcon = {
  name: '设置'
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}
const buttomIconArr = ref<ButtomIcon[]>([
  {
    name: '设置',
    grey: settingGrey,
    white: settingWhite,
    src: settingGrey,
    showAlt: false,
    i18nKey: 'common.setting'
  }
])

const libraryHandleClick = (item: Icon) => {
  emit('librarySelectedChange', item)
}

// 拖拽时的库切换逻辑
const iconDragEnter = (event: DragEvent, item: Icon) => {
  // 检查是否是歌曲拖拽
  const isSongDrag = event.dataTransfer?.types?.includes('application/x-song-drag')

  if (isSongDrag && item.name !== selectedIcon.value.name) {
    // 当拖拽歌曲时，自动切换到对应的库
    clickIcon(item)
    // 同时触发库切换事件，通知父组件更新
    libraryHandleClick(item)
  }
}
</script>
<template>
  <div class="librarySelectArea unselectable">
    <div>
      <div
        v-for="item of iconArr"
        :key="item.name"
        class="iconBox"
        @click="clickIcon(item)"
        @mouseover="iconMouseover(item)"
        @mouseout="iconMouseout(item)"
        @dragenter="iconDragEnter($event, item)"
      >
        <div
          style="width: 2px; height: 100%"
          :style="{ backgroundColor: item.name == selectedIcon.name ? 'var(--accent)' : '' }"
        ></div>
        <div
          style="
            flex-grow: 1;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
          "
          @click="libraryHandleClick(item)"
        >
          <img
            :src="item.src"
            draggable="false"
            :ref="(el) => setIconRef(item.name, el)"
            :class="{ 'theme-icon': item.src === item.white }"
          />
          <bubbleBox
            :dom="iconRefMap[item.name] || undefined"
            :title="t((item as any).i18nKey || item.name)"
          />
        </div>
      </div>
    </div>
    <div>
      <div
        v-for="item of buttomIconArr"
        :key="item.name"
        class="iconBox"
        @click="clickButtomIcon(item)"
        @mouseover="iconMouseover(item)"
        @mouseout="iconMouseout(item)"
      >
        <div style="width: 2px; height: 100%"></div>
        <div
          style="
            flex-grow: 1;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <img
            :src="item.src"
            draggable="false"
            :ref="(el) => setIconRef(item.name, el)"
            :class="{ 'theme-icon': item.src === item.white }"
          />
          <bubbleBox
            :dom="iconRefMap[item.name] || undefined"
            :title="t(item.i18nKey || 'common.setting')"
          />
        </div>
      </div>
    </div>
    <settingDialog v-if="settingDialogShow" @cancel="settingDialogShow = false" />
  </div>
</template>
<style lang="scss" scoped>
.librarySelectArea {
  height: 100%;
  width: 45px;
  border-right: 1px solid var(--border);
  background-color: var(--bg);
  display: flex;
  justify-content: space-between;
  flex-direction: column;

  .fade-enter-active,
  .fade-leave-active {
    transition: opacity 0.15s;
  }

  .fade-enter,
  .fade-leave-to {
    opacity: 0;
  }

  .iconBox {
    width: 45px;
    height: 45px;
    display: flex;
    justify-content: center;
    align-items: center;

    img {
      width: 25px;
      height: 25px;
    }
  }

  .bubbleBox {
    height: 22px;
    line-height: 22px;
    text-align: center;
    position: relative;
    border-radius: 3px;
    border: 1px solid var(--border);
    font-size: 12px;
    background-color: var(--bg-elev);
    padding: 0 10px;
  }

  .bubbleBox::before {
    content: '';
    position: absolute;
    width: 0;
    height: 0;
    top: 5px;
    left: -5px;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-right: 5px solid var(--border);
  }
}
</style>
