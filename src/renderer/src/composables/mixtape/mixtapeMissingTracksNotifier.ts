import confirmDialog from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { normalizeUniquePaths } from '@renderer/composables/mixtape/mixtapeTrackSnapshot'

export const createMixtapeMissingTracksNotifier = () => {
  let lastMissingRemovalSignature = ''

  const notifyMissingTracksRemoved = async (playlistId: string, removedPaths: string[]) => {
    const normalized = normalizeUniquePaths(removedPaths)
    if (!normalized.length) return
    const signature = `${playlistId || ''}::${normalized.slice().sort().join('|')}`
    if (signature === lastMissingRemovalSignature) return
    lastMissingRemovalSignature = signature

    const displayNames = Array.from(
      new Set(normalized.map((item) => item.split(/[/\\]/).pop() || item))
    )
    const previewNames = displayNames.slice(0, 6)
    const moreCount = Math.max(0, displayNames.length - previewNames.length)
    const content = [
      t('mixtape.missingTracksRemovedSummary', { count: normalized.length }),
      ...previewNames.map((name) => `- ${name}`)
    ]
    if (moreCount > 0) {
      content.push(t('mixtape.missingTracksRemovedMore', { count: moreCount }))
    }

    await confirmDialog({
      title: t('mixtape.missingTracksRemovedTitle'),
      content,
      confirmShow: false,
      textAlign: 'left',
      innerHeight: 0,
      innerWidth: 460
    })
  }

  return {
    notifyMissingTracksRemoved
  }
}
