<script setup lang="ts">
import chromeMaximize from '@renderer/assets/chrome-maximize.svg?asset'
import chromeRestore from '@renderer/assets/chrome-restore.svg?asset'
import chromeMiniimize from '@renderer/assets/chrome-minimize.svg?asset'
import logo from '@renderer/assets/logo.png?asset'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ref } from 'vue'
import menuComponent from './menu.vue'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
const emit = defineEmits(['openDialog'])
const toggleMaximize = () => {
  window.electron.ipcRenderer.send('toggle-maximize')
}

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('toggle-minimize')
}

const toggleClose = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: '退出',
      content: [t('请等待当前任务执行结束')],
      confirmShow: false
    })
    return
  }
  window.electron.ipcRenderer.send('toggle-close')
}
const runtime = useRuntimeStore()

window.electron.ipcRenderer.on('mainWin-max', (event, bool) => {
  runtime.isWindowMaximized = bool
})

const fillColor = ref('#9d9d9d')
type MenuItem = { name: string; shortcutKey?: string }

type Menu = {
  name: string
  show: boolean
  subMenu: MenuItem[][]
}

const menuArr = ref<Menu[]>([
  {
    name: '文件(F)',
    show: false,
    subMenu: [
      [
        { name: '筛选库 导入新曲目', shortcutKey: 'Alt+Q' },
        { name: '精选库 导入新曲目', shortcutKey: 'Alt+E' }
      ],
      [{ name: '手动添加曲目指纹' }],
      [{ name: '退出' }]
    ]
  },
  {
    name: '迁移(G)',
    show: false,
    subMenu: [
      [{ name: '导出曲目指纹库文件' }, { name: '导入曲目指纹库文件' }]
      // [{ name: '导出迁移文件' }, { name: '导入迁移文件' }]
    ]
  },
  {
    name: '云同步(C)',
    show: false,
    subMenu: [[{ name: '同步曲目指纹库' }], [{ name: '云同步设置' }]]
  },
  {
    name: '帮助(H)',
    show: false,
    subMenu: [[{ name: '访问 GitHub', shortcutKey: 'F1' }, { name: '检查更新' }, { name: '关于' }]]
  }
])
hotkeys('alt+f', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === '文件(F)') {
      item.show = true
      return
    }
  })
})
hotkeys('alt+g', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === '迁移(G)') {
      item.show = true
      return
    }
  })
})
hotkeys('alt+c', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === '云同步(C)') {
      item.show = true
      return
    }
  })
})
hotkeys('alt+h', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === '帮助(H)') {
      item.show = true
      return
    }
  })
})

hotkeys('alt+q', 'windowGlobal', () => {
  ;(async () => {
    await scanNewSongDialog({ libraryName: '筛选库', songListUuid: '' })
  })()
})

hotkeys('alt+e', 'windowGlobal', () => {
  ;(async () => {
    await scanNewSongDialog({ libraryName: '精选库', songListUuid: '' })
  })()
})
const menuClick = (item: Menu) => {
  item.show = true
}
const menuButtonClick = async (item: MenuItem) => {
  if (
    item.name === '筛选库 导入新曲目' ||
    item.name === '精选库 导入新曲目' ||
    item.name === '手动添加曲目指纹' ||
    item.name === '导出曲目指纹库文件' ||
    item.name === '导入曲目指纹库文件' ||
    item.name === '导出迁移文件' ||
    item.name === '导入迁移文件'
  ) {
    if (runtime.isProgressing) {
      await confirm({
        title: '导入',
        content: [t('请等待当前导入任务完成')],
        confirmShow: false
      })
      return
    }
    if (item.name === '筛选库 导入新曲目') {
      await scanNewSongDialog({ libraryName: '筛选库', songListUuid: '' })
      return
    } else if (item.name === '精选库 导入新曲目') {
      await scanNewSongDialog({ libraryName: '精选库', songListUuid: '' })
      return
    }
  }
  emit('openDialog', item.name)
}

const switchMenu = (direction: 'next' | 'prev', menuName: string) => {
  let index = menuArr.value.findIndex((item) => item.name === menuName)
  if (direction === 'next') {
    if (menuArr.value.length - 1 === index) {
      index = 0
    } else {
      index++
    }
  } else if (direction === 'prev') {
    if (index === 0) {
      index = menuArr.value.length - 1
    } else {
      index--
    }
  }
  menuArr.value[index].show = true
}
const titleMenuButtonMouseEnter = (item: Menu) => {
  if (menuArr.value.findIndex((item) => item.show === true) === -1) {
    return
  }
  item.show = true
}
</script>
<template>
  <div class="title unselectable">FRKB - {{ t('快速音频整理工具') }}</div>
  <div class="titleComponent unselectable">
    <div
      style="
        z-index: 1;
        padding-left: 10px;
        display: flex;
        justify-content: center;
        align-items: center;
      "
    >
      <img :src="logo" style="width: 20px" :draggable="false" />
    </div>
    <div style="z-index: 1; padding-left: 5px" v-for="item in menuArr" :key="item.name">
      <div
        class="functionButton"
        :class="{ functionButtonHover: item.show }"
        @click.stop="menuClick(item)"
        @mouseenter="titleMenuButtonMouseEnter(item)"
      >
        {{ t(item.name) }}
      </div>
      <menuComponent
        :menuArr="item.subMenu"
        :menuName="item.name"
        v-model="item.show"
        @menuButtonClick="menuButtonClick"
        @switchMenu="switchMenu"
      ></menuComponent>
    </div>
    <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
    <div style="display: flex; z-index: 1">
      <div class="rightIcon" @click="toggleMinimize()">
        <img :src="chromeMiniimize" :draggable="false" />
      </div>
      <div class="rightIcon" @click="toggleMaximize()">
        <img :src="runtime.isWindowMaximized ? chromeRestore : chromeMaximize" :draggable="false" />
      </div>
      <div
        class="rightIcon closeIcon"
        @mouseover="fillColor = '#ffffff'"
        @mouseout="fillColor = '#9d9d9d'"
        @click="toggleClose()"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 15 15"
          xmlns="http://www.w3.org/2000/svg"
          :fill="fillColor"
        >
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
          />
        </svg>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.functionButton {
  height: 22px;
  line-height: 22px;
  padding: 0 5px;

  font-size: 12px;
  border-radius: 5px;
}

.functionButton:hover {
  background-color: #2d2e2e;
}

.functionButtonHover {
  background-color: #2d2e2e;
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #181818;
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid #424242;
}

.titleComponent {
  width: 100vw;
  height: 35px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  box-sizing: border-box;

  .rightIcon {
    width: 47px;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 35px;
    transition: background-color 0.15s ease;
  }

  .rightIcon:hover {
    background-color: #373737;
  }

  .closeIcon:hover {
    background-color: #e81123;
  }
}
</style>
