import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.scss'
import messages from '@intlify/unplugin-vue-i18n/messages'

console.log(messages)
const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'enUS', //todo
  // locale: "zhCN",
  messages
})
const pinia = createPinia()
const app = createApp(App)

app.use(i18n)
app.use(pinia)
app.mount('#app')
