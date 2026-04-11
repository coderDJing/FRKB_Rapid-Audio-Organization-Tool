import { createVNode, render } from 'vue'
import Dialog from './conversionFinishedSummaryDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export default (summary: unknown, errors?: unknown[]) => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const vnode = createVNode(Dialog, {
      summary,
      errors,
      onClose: () => {
        render(null, div)
        div.remove()
        resolve('close')
      }
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
