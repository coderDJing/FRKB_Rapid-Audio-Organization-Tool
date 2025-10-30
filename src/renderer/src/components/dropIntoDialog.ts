import { createVNode, render } from 'vue'
import ImportTracksDialogBase from './ImportTracksDialogBase.vue'

interface IArgs {
  songListUuid: string
  libraryName: string
}
interface IResult {
  importingSongListUUID: string
  songListPath: string
  isDeleteSourceFile: boolean
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
  deduplicateMode: 'library' | 'batch'
}
export default ({ songListUuid, libraryName }: IArgs): Promise<IResult | 'cancel'> => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (result: IResult) => {
      render(null, div)
      div.remove()
      resolve(result)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(ImportTracksDialogBase, {
      mode: 'drop',
      songListUuid,
      libraryName,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
