import { createVNode, render } from 'vue'
import confirmDialog from './confirmDialog.vue'

export default ({ title, content, confirmShow, textAlign, innerHeight, innerWidth }) => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const confirmCallback = () => {
      render(null, div)
      div.remove()
      resolve('confirm')
    }
    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(confirmDialog, {
      title,
      content,
      confirmShow,
      textAlign,
      innerHeight,
      innerWidth,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
