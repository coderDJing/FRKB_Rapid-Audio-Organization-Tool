import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './FoundNewVersion.vue'
import './styles/main.scss'
import { useRuntimeStore } from '@renderer/stores/runtime'

const pinia = createPinia()
const app = createApp(App)

app.config.errorHandler = (err: Error) => {
  window.electron.ipcRenderer.send('outputLog', `VUE全局错误捕获: ${err.stack}`)
  console.error(`VUE全局错误捕获: ${err.stack}`)
}

app.use(pinia)

async function initializeApp() {
  const runtime = useRuntimeStore()
  runtime.setting = await window.electron.ipcRenderer.invoke('getSetting')
  app.mount('#app')
}

initializeApp()