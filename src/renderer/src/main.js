import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import enUS from './language/en-US'
import zhCN from './language/zh-CN'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.scss'


const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: "enUS",//todo
  // locale: "zhCN",
  messages: {
    enUS, zhCN
  },
})
const pinia = createPinia()
const app = createApp(App)

app.use(i18n)
app.use(pinia)
app.mount('#app')
