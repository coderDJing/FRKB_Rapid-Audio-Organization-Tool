import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './DatabaseInit.vue'
import './styles/main.scss'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { i18n } from '@renderer/i18n'

const pinia = createPinia()
const app = createApp(App)

app.config.errorHandler = (err: Error) => {
  window.electron.ipcRenderer.send('outputLog', `VUE全局错误捕获: ${err.stack}`)
  console.error(`VUE全局错误捕获: ${err.stack}`)
}

app.use(pinia)
app.use(i18n)

async function initializeApp() {
  const runtime = useRuntimeStore()
  runtime.setting = await window.electron.ipcRenderer.invoke('getSetting')
  // 主题：根据设置为根容器添加 theme-light/theme-dark 类
  const rootEl = document.getElementById('app')
  const prefersDarkMedia = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : (null as any)
  const getSystemDark = () => {
    try {
      return !!prefersDarkMedia?.matches
    } catch {
      return false
    }
  }
  const applyThemeClass = (mode: 'system' | 'light' | 'dark', isSystemDark?: boolean) => {
    try {
      const htmlEl = document.documentElement
      const bodyEl = document.body
      if (rootEl) rootEl.classList.remove('theme-dark', 'theme-light')
      htmlEl.classList.remove('theme-dark', 'theme-light')
      bodyEl.classList.remove('theme-dark', 'theme-light')
      const effectiveDark = mode === 'dark' || (mode === 'system' && !!isSystemDark)
      const themeClass = effectiveDark ? 'theme-dark' : 'theme-light'
      if (rootEl) rootEl.classList.add(themeClass)
      htmlEl.classList.add(themeClass)
      bodyEl.classList.add(themeClass)
    } catch {}
  }
  // 首次启动按设置（默认 system）或用户选择
  applyThemeClass(((runtime.setting as any).themeMode || 'system') as any, getSystemDark())
  // 监听设置变更与系统主题变更
  try {
    watch(
      () => (runtime.setting as any).themeMode,
      (mode: 'system' | 'light' | 'dark') => applyThemeClass(mode || 'system', getSystemDark())
    )
    prefersDarkMedia?.addEventListener?.('change', (e: MediaQueryListEvent) => {
      if (((runtime.setting as any).themeMode || 'system') === 'system') {
        applyThemeClass('system', !!e.matches)
      }
    })
  } catch {}
  // macOS 下为根容器增加 is-mac 类，用于样式细节覆盖
  try {
    if (runtime.setting.platform === 'darwin') {
      if (rootEl) rootEl.classList.add('is-mac')
    }
  } catch {}

  if (!runtime.setting.language) {
    let userLang = navigator.language
    if (userLang !== 'zh-CN') {
      runtime.setting.language = 'enUS'
    } else {
      runtime.setting.language = 'zhCN'
    }
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }

  // 根据设置更新i18n语言
  const { setLocale } = await import('@renderer/i18n')
  if (runtime.setting.language === 'enUS') {
    setLocale('en-US')
  } else {
    setLocale('zh-CN')
  }
  // 监听设置中的语言变更，实时应用到 i18n
  watch(
    () => runtime.setting.language,
    (lang) => {
      i18n.global.locale.value = lang === 'enUS' ? 'en-US' : 'zh-CN'
    }
  )
  app.mount('#app')
}

initializeApp()
