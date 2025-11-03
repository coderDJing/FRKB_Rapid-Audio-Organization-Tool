import { createVNode, render } from 'vue'
import Dialog from './conversionFinishedSummaryDialog.vue'

export default (summary: any) => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const vnode = createVNode(Dialog, {
      summary,
      onClose: () => {
        render(null, div)
        div.remove()
        resolve('close')
      }
    })
    render(vnode, div)
  })
}
