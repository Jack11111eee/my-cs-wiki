import DefaultTheme from 'vitepress/theme'
import Layout from './Layout.vue'
import ContribCharts from './ContribCharts.vue'
import './fonts.css'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('ContribCharts', ContribCharts)
  },
}