import { createVNode, render } from 'vue'
import AudioConvertDialogVue from './audioConvertDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

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
    attachAppContext(vnode)
    render(vnode, div)
  })
}
