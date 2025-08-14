import { createVNode, render } from 'vue'
import AddSongFingerprintFinishedDialog from './addSongFingerprintFinishedDialog.vue'

export interface FingerprintSummary {
  startAt: string
  endAt: string
  durationMs: number
  scannedCount: number
  analyzeFailedCount: number
  duplicatesRemovedCount: number
  fingerprintAddedCount: number
  fingerprintTotalBefore: number
  fingerprintTotalAfter: number
}

export default (summary: FingerprintSummary) => {
  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const onClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }
    const vnode = createVNode(AddSongFingerprintFinishedDialog, { summary, onClose })
    render(vnode, div)
  })
}
