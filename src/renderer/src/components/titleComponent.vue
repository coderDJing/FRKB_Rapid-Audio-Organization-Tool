<script setup lang="ts">
import chromeMaximizeAsset from '@renderer/assets/chrome-maximize.svg?asset'
import chromeRestoreAsset from '@renderer/assets/chrome-restore.svg?asset'
import chromeMiniimizeAsset from '@renderer/assets/chrome-minimize.svg?asset'
import logoAsset from '@renderer/assets/logo.png?asset'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ref } from 'vue'
import menuComponent from './menu.vue'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'

const chromeMaximize = chromeMaximizeAsset
const chromeRestore = chromeRestoreAsset
const chromeMiniimize = chromeMiniimizeAsset
const logo = logoAsset
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
      title: t('common.exit'),
      content: [t('import.waitForTask')],
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
type MenuItem = {
  name: string
  shortcutKey?: string
  i18nParams?: Record<string, any>
  action?: string
}

type Menu = {
  name: string
  show: boolean
  subMenu: MenuItem[][]
}

const menuArr = ref<Menu[]>([
  {
    name: 'menu.file',
    show: false,
    subMenu: [
      [
        {
          name: 'library.importNewTracks',
          shortcutKey: 'Alt+Q',
          i18nParams: { libraryTypeKey: 'library.filter' },
          action: 'import-new-filter'
        },
        {
          name: 'library.importNewTracks',
          shortcutKey: 'Alt+E',
          i18nParams: { libraryTypeKey: 'library.curated' },
          action: 'import-new-curated'
        }
      ],
      [{ name: 'fingerprints.manualAdd', action: 'manual-add-fingerprint' }],
      [{ name: 'menu.exit', action: 'exit' }]
    ]
  },
  {
    name: 'menu.migration',
    show: false,
    subMenu: [[{ name: 'fingerprints.exportDatabase' }, { name: 'fingerprints.importDatabase' }]]
  },
  {
    name: 'menu.cloudSync',
    show: false,
    subMenu: [[{ name: 'cloudSync.syncFingerprints' }], [{ name: 'cloudSync.settings' }]]
  },
  {
    name: 'menu.help',
    show: false,
    subMenu: [
      [{ name: 'menu.visitGithub', shortcutKey: 'F1' }, { name: 'menu.visitWebsite' }],
      [
        { name: 'menu.checkUpdate' },
        { name: 'menu.whatsNew' },
        { name: 'menu.thirdPartyNotices' },
        { name: 'menu.about' }
      ]
    ]
  }
])
hotkeys('alt+f', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === 'menu.file') {
      item.show = true
      return
    }
  })
})
hotkeys('alt+g', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === 'menu.migration') {
      item.show = true
      return
    }
  })
})
hotkeys('alt+c', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === 'menu.cloudSync') {
      item.show = true
      return
    }
  })
})
hotkeys('alt+h', 'windowGlobal', () => {
  menuArr.value.forEach((item) => {
    if (item.name === 'menu.help') {
      item.show = true
      return
    }
  })
})

hotkeys('alt+q', 'windowGlobal', () => {
  ;(async () => {
    await scanNewSongDialog({ libraryName: 'FilterLibrary', songListUuid: '' })
  })()
})

hotkeys('alt+e', 'windowGlobal', () => {
  ;(async () => {
    await scanNewSongDialog({ libraryName: 'CuratedLibrary', songListUuid: '' })
  })()
})
const menuClick = (item: Menu) => {
  item.show = true
}
const menuButtonClick = async (item: MenuItem) => {
  if (
    item.name === 'library.importNewTracks' ||
    item.name === 'fingerprints.manualAdd' ||
    item.name === 'fingerprints.exportDatabase' ||
    item.name === 'fingerprints.importDatabase'
  ) {
    if (runtime.isProgressing) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    }
    if (item.action === 'import-new-filter') {
      await scanNewSongDialog({ libraryName: 'FilterLibrary', songListUuid: '' })
      return
    } else if (item.action === 'import-new-curated') {
      await scanNewSongDialog({ libraryName: 'CuratedLibrary', songListUuid: '' })
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
  <div class="title unselectable">FRKB - {{ t('app.name') }}</div>
  <div class="titleComponent unselectable">
    <div
      v-if="runtime.platform !== 'Mac'"
      style="
        z-index: 1;
        padding-left: 10px;
        display: flex;
        justify-content: center;
        align-items: center;
      "
    >
      <img :src="logo" style="width: 20px" :draggable="false" class="theme-icon" />
    </div>
    <template v-if="runtime.platform !== 'Mac'">
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
    </template>
    <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
    <div v-if="runtime.platform !== 'Mac'" style="display: flex; z-index: 1">
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
  background-color: var(--hover);
}

.functionButtonHover {
  background-color: var(--hover);
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: var(--bg);
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
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
    background-color: var(--hover);
  }

  .closeIcon:hover {
    background-color: #e81123;
  }
}
</style>
