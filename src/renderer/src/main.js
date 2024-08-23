import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.scss'
import messages from '@intlify/unplugin-vue-i18n/messages'
import { useRuntimeStore } from '@renderer/stores/runtime'

const pinia = createPinia()
const app = createApp(App)

app.config.errorHandler = (err) => {
  window.electron.ipcRenderer.send('outputLog', `VUE全局错误捕获: ${err.stack}`)
  console.error(`VUE全局错误捕获: ${err.stack}`)
}
app.use(pinia)
const runtime = useRuntimeStore()
runtime.setting = await window.electron.ipcRenderer.invoke('getSetting')

if (!runtime.setting.language) {
  let userLang = navigator.language || navigator.userLanguage
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

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: runtime.setting.language,
  // locale: "zhCN",
  messages
})

app.use(i18n)

app.mount('#app')

export default { i18n }
