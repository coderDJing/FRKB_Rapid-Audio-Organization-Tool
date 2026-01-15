import DefaultTheme from 'vitepress/theme'
import Home from './Home.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // 注册全局组件，这样在 Markdown 里写 <Home /> 就能用
    app.component('Home', Home)
  }
}
