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
  // macOS 下为根容器增加 is-mac 类，用于样式细节覆盖
  try {
    const isMac = /Mac/i.test(navigator.userAgent)
    if (isMac) {
      const rootEl = document.getElementById('app')
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
