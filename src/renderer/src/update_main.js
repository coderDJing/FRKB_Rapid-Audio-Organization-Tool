import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './Update.vue'
import './styles/main.scss'
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

// if (!runtime.setting.language) {
//   let userLang = navigator.language || navigator.userLanguage
//   if (userLang !== 'zh-CN') {
//     runtime.setting.language = 'enUS'
//   } else {
//     runtime.setting.language = 'zhCN'
//   }
//   await window.electron.ipcRenderer.invoke(
//     'setSetting',
//     JSON.parse(JSON.stringify(runtime.setting))
//   )
// }

app.mount('#app')
