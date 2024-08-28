<script setup>
import listGrey from '@renderer/assets/list-grey.png'
import listWhite from '@renderer/assets/list-white.png'
import likeGrey from '@renderer/assets/like-grey.png'
import likeWhite from '@renderer/assets/like-white.png'
import settingGrey from '@renderer/assets/setting-grey.png'
import settingWhite from '@renderer/assets/setting-white.png'
import { ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import settingDialog from '@renderer/components/settingDialog.vue'
import { t } from '@renderer/utils/translate.js'
const emit = defineEmits(['librarySelectedChange'])
const iconArr = ref([
  {
    name: '筛选库',
    grey: listGrey,
    white: listWhite,
    src: listGrey,
    showAlt: false
  },
  {
    name: '精选库',
    grey: likeGrey,
    white: likeWhite,
    src: likeGrey,
    showAlt: false
  }
])

const selectedIcon = ref(iconArr.value[0])
selectedIcon.value.src = selectedIcon.value.white

const runtime = useRuntimeStore()
const clickIcon = (item) => {
  if (item.name == selectedIcon.value.name) {
    return
  }
  runtime.libraryAreaSelected = item.name
  selectedIcon.value.src = selectedIcon.value.grey
  selectedIcon.value = item
  selectedIcon.value.src = selectedIcon.value.white
}

const settingDialogShow = ref(false)
const clickButtomIcon = (item) => {
  if (item.name == '设置') {
    settingDialogShow.value = true
    return
  }
}
let hoverTimer = null
const iconMouseover = (item) => {
  if (selectedIcon.value != item) {
    item.src = item.white
  }
  hoverTimer = setTimeout(() => {
    item.showAlt = true
  }, 500)
}
const iconMouseout = (item) => {
  clearTimeout(hoverTimer)
  if (selectedIcon.value != item) {
    item.src = item.grey
  }
  item.showAlt = false
}

const buttomIconArr = ref([
  {
    name: '设置',
    grey: settingGrey,
    white: settingWhite,
    src: settingGrey,
    showAlt: false
  }
])

const libraryHandleClick = (item) => {
  emit('librarySelectedChange', item)
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
      >
        <div
          style="width: 2px; height: 100%"
          :style="{ backgroundColor: item.name == selectedIcon.name ? '#0078d4' : '' }"
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
          <img :src="item.src" draggable="false" />
          <transition name="fade">
            <div class="bubbleBox" v-if="item.showAlt" style="position: absolute; left: 50px">
              {{ t(item.name) }}
            </div>
          </transition>
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
        <div
          style="width: 2px; height: 100%"
          :style="{ backgroundColor: item.name == selectedIcon.name ? '#0078d4' : '' }"
        ></div>
        <div
          style="
            flex-grow: 1;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <img :src="item.src" draggable="false" />
          <transition name="fade">
            <div class="bubbleBox" v-if="item.showAlt" style="position: absolute; left: 50px">
              {{ t(item.name) }}
            </div>
          </transition>
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
  border-right: 1px solid #2b2b2b;
  background-color: #181818;
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
    cursor: pointer;

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
    border: 1px solid #424242;
    font-size: 12px;
    background-color: #202020;
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
    border-right: 5px solid #424242;
  }
}
</style>
