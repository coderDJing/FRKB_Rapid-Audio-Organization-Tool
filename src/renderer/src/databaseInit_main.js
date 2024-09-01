import { createApp } from 'vue'
import App from './DatabaseInit.vue'
import './styles/main.scss'
const app = createApp(App)

app.config.errorHandler = (err) => {
  window.electron.ipcRenderer.send('outputLog', `VUE全局错误捕获: ${err.stack}`)
  console.error(`VUE全局错误捕获: ${err.stack}`)
}

let setting = await window.electron.ipcRenderer.invoke('getSetting')
if (!setting.language) {
  let userLang = navigator.language || navigator.userLanguage
  if (userLang !== 'zh-CN') {
    setting.language = 'enUS'
  } else {
    setting.language = 'zhCN'
  }
  await window.electron.ipcRenderer.invoke('setSetting', JSON.parse(JSON.stringify(setting)))
}

app.mount('#app')
