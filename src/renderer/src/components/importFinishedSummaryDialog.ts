import { createVNode, render } from 'vue'
import ImportFinishedSummaryDialog from './importFinishedSummaryDialog.vue'

export interface ImportSummary {
  startAt: string
  endAt: string
  durationMs: number
  scannedCount: number
  analyzeFailedCount: number
  importedToPlaylistCount: number
  duplicatesRemovedCount: number
  fingerprintAddedCount: number
  fingerprintAlreadyExistingCount: number
  fingerprintTotalBefore: number
  fingerprintTotalAfter: number
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
}

export default (summary: ImportSummary) => {
  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const onClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }
    const vnode = createVNode(ImportFinishedSummaryDialog, { summary, onClose })
    render(vnode, div)
  })
}
