import { createVNode, render } from 'vue'
import AudioConvertDialogVue from './audioConvertDialog.vue'

export default (args: { sourceExts?: string[] }) => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const confirmCallback = (payload: any) => {
      render(null, div)
      div.remove()
      resolve(payload)
    }
    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(AudioConvertDialogVue, {
      confirmCallback,
      cancelCallback,
      sourceExts: args?.sourceExts || []
    })
    render(vnode, div)
  })
}
