import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import 'overlayscrollbars/overlayscrollbars.css'
import './styles/main.scss'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { i18n } from '@renderer/i18n'
import dialogDrag from './directives/dialogDrag'

const pinia = createPinia()
const app = createApp(App)

app.directive('dialog-drag', dialogDrag)

app.config.errorHandler = (err: Error) => {
  window.electron.ipcRenderer.send('outputLog', `VUE全局错误捕获: ${err.stack}`)
  console.error(`VUE全局错误捕获: ${err.stack}`)
}
app.use(pinia)
app.use(i18n)
;(window as any).__FRKB_APP_CONTEXT__ = app._context
const initializeApp = async () => {
  const runtime = useRuntimeStore()
  runtime.setting = await window.electron.ipcRenderer.invoke('getSetting')
  // 初始化主题：根据设置、系统推送选择 theme-dark/theme-light 类
  const rootEl = document.getElementById('app')
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
  // 首次启动按设置（默认 system）或用户选择，跟随系统由主进程广播
  applyThemeClass(((runtime.setting as any).themeMode || 'system') as any, getSystemDark())
  // 当主进程在 system 模式下广播系统主题变更时，实时更新
  window.electron.ipcRenderer.on('theme/system-updated', (_e, payload: { isDark: boolean }) => {
    if (((runtime.setting as any).themeMode || 'system') === 'system') {
      applyThemeClass('system', !!payload?.isDark)
    }
  })
  // 监听设置中 themeMode 的变化（light/dark/system）
  watch(
    () => (runtime.setting as any).themeMode,
    (mode: 'system' | 'light' | 'dark') => {
      applyThemeClass(mode || 'system', getSystemDark())
    }
  )
  // 作为兜底：若系统主题变化但主进程广播未到，前端也能感知（仅在 system 模式下）
  try {
    prefersDarkMedia?.addEventListener?.('change', (e: MediaQueryListEvent) => {
      if (((runtime.setting as any).themeMode || 'system') === 'system') {
        applyThemeClass('system', !!e.matches)
      }
    })
  } catch {}
  // macOS 下为根容器增加 is-mac 类，用于样式细节覆盖
  try {
    if (runtime.setting.platform === 'darwin' && rootEl) {
      rootEl.classList.add('is-mac')
    }
  } catch {}
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
