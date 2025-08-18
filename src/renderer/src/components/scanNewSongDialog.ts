import { createVNode, render } from 'vue'
import ImportTracksDialogBase from './ImportTracksDialogBase.vue'
export default ({ libraryName, songListUuid }: { libraryName: string; songListUuid: string }) => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
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
    const vnode = createVNode(ImportTracksDialogBase, {
      mode: 'scan',
      libraryName,
      songListUuid,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
