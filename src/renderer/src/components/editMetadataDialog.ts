import { createVNode, render } from 'vue'
import editMetadataDialog from './editMetadataDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { ISongInfo, ITrackMetadataDetail } from 'src/types/globals'

export default ({
  filePath
}: {
  filePath: string
}): Promise<
  'cancel' | { updatedSongInfo: ISongInfo; detail: ITrackMetadataDetail; oldFilePath: string }
> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (data: {
      updatedSongInfo: ISongInfo
      detail: ITrackMetadataDetail
      oldFilePath: string
    }) => {
      render(null, div)
      div.remove()
      resolve(data)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(editMetadataDialog, {
      filePath,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
