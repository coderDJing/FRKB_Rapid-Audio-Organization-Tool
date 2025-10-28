import { app, BrowserWindow, Menu } from 'electron'
import zhCNLocale from '../../renderer/src/i18n/locales/zh-CN.json'
import enUSLocale from '../../renderer/src/i18n/locales/en-US.json'
import store from '../store'
import mainWindow from '../window/mainWindow'

// 依据当前设置返回语言 ID
const getCurrentLocaleId = (): 'zh-CN' | 'en-US' =>
  (store.settingConfig as any)?.language === 'enUS' ? 'en-US' : 'zh-CN'

// 简单的字典查找（key 形如 a.b.c）
const tMenu = (key: string): string => {
  const MESSAGES: Record<'zh-CN' | 'en-US', any> = {
    'zh-CN': zhCNLocale as any,
    'en-US': enUSLocale as any
  }
  const localeId = getCurrentLocaleId()
  const parts = key.split('.')
  let cur: any = MESSAGES[localeId]
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
    else return key
  }
  return typeof cur === 'string' ? cur : key
}

const sanitizeLabelForMac = (label: string): string => {
  if (process.platform !== 'darwin') return label
  return label.replace(/\s*(\([A-Za-z]\)|（[A-Za-z]）)/g, '')
}

const labelImportTo = (libraryKey: 'library.filter' | 'library.curated') => {
  const tpl = tMenu('library.importNewTracks')
  const lib = tMenu(libraryKey)
  return tpl.replace('{libraryType}', lib)
}

const buildAppOnlyMenu = () =>
  Menu.buildFromTemplate([
    {
      label: 'FRKB',
      submenu: [
        { role: 'hide', label: getCurrentLocaleId() === 'en-US' ? 'Hide FRKB' : '隐藏 FRKB' },
        {
          role: 'hideOthers',
          label: getCurrentLocaleId() === 'en-US' ? 'Hide Others' : '隐藏其他'
        },
        { role: 'unhide', label: getCurrentLocaleId() === 'en-US' ? 'Show All' : '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: getCurrentLocaleId() === 'en-US' ? 'Quit FRKB' : '退出 FRKB' }
      ]
    }
  ])

const buildFullMenu = () =>
  Menu.buildFromTemplate([
    {
      label: 'FRKB',
      submenu: [
        { role: 'hide', label: getCurrentLocaleId() === 'en-US' ? 'Hide FRKB' : '隐藏 FRKB' },
        {
          role: 'hideOthers',
          label: getCurrentLocaleId() === 'en-US' ? 'Hide Others' : '隐藏其他'
        },
        { role: 'unhide', label: getCurrentLocaleId() === 'en-US' ? 'Show All' : '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: getCurrentLocaleId() === 'en-US' ? 'Quit FRKB' : '退出 FRKB' }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.file')),
      submenu: [
        {
          label: labelImportTo('library.filter'),
          click: () => mainWindow.instance?.webContents.send('tray-action', 'import-new-filter')
        },
        {
          label: labelImportTo('library.curated'),
          click: () => mainWindow.instance?.webContents.send('tray-action', 'import-new-curated')
        },
        { type: 'separator' },
        {
          label: tMenu('fingerprints.manualAdd'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'fingerprints.manualAdd')
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.migration')),
      submenu: [
        {
          label: tMenu('fingerprints.exportDatabase'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'fingerprints.exportDatabase'
            )
        },
        {
          label: tMenu('fingerprints.importDatabase'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'fingerprints.importDatabase'
            )
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.cloudSync')),
      submenu: [
        {
          label: tMenu('cloudSync.syncFingerprints'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'cloudSync.syncFingerprints'
            )
        },
        {
          label: tMenu('cloudSync.settings'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'cloudSync.settings')
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.help')),
      submenu: [
        {
          label: tMenu('menu.visitGithub'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.visitGithub')
        },
        {
          label: tMenu('menu.visitWebsite'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.visitWebsite')
        },
        { type: 'separator' },
        {
          label: tMenu('menu.checkUpdate'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.checkUpdate')
        },
        {
          label: tMenu('menu.about'),
          click: () => mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.about')
        }
      ]
    }
  ])

// 应在 app ready 后调用：初始化仅 FRKB 菜单，并随焦点在 App-only 与 Full 之间切换
export const setupMacMenus = () => {
  if (process.platform !== 'darwin') return
  try {
    Menu.setApplicationMenu(buildAppOnlyMenu())
    app.on('browser-window-focus', (_e, win) => {
      if (win && mainWindow.instance && win.id === mainWindow.instance.id) {
        Menu.setApplicationMenu(buildFullMenu())
      } else {
        Menu.setApplicationMenu(buildAppOnlyMenu())
      }
    })
  } catch {}
}

// 语言切换后调用：根据当前聚焦窗口重建菜单（不重复绑定事件）
export const rebuildMacMenusForCurrentFocus = () => {
  if (process.platform !== 'darwin') return
  try {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && mainWindow.instance && focused.id === mainWindow.instance.id) {
      Menu.setApplicationMenu(buildFullMenu())
    } else {
      Menu.setApplicationMenu(buildAppOnlyMenu())
    }
  } catch {}
}

export default {
  setupMacMenus,
  rebuildMacMenusForCurrentFocus
}
