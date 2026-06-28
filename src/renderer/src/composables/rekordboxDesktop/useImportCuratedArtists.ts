import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { loadRekordboxPlaylistTracks } from '@renderer/composables/rekordboxDesktop/useRekordboxTrackLoader'
import { flattenPlayableNodes } from '@renderer/composables/rekordboxDesktop/useRekordboxTreeUtils'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'

type RunWithBusy = <T>(task: () => Promise<T>) => Promise<T>

type ImportCuratedArtistsResult = {
  artists?: unknown[]
  count?: number
  importedTrackCount?: number
  fingerprintedTrackCount?: number
  artistOnlyTrackCount?: number
}

interface ImportCuratedArtistsOptions {
  /** 'node'：导入选中的播放列表/文件夹；'wholeLibrary'：导入整个曲库 */
  scope: 'node' | 'wholeLibrary'
  /** scope='node' 时必传：被右键的节点 */
  node?: IPioneerPlaylistTreeNode
  sourceKind: RekordboxSourceKind
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
  /** 整库导入时用于显示来源名 */
  sourceName?: string
  runWithBusy: RunWithBusy
  isBusy: () => boolean
}

/** 加载整个库的播放列表树（desktop / usb 统一） */
const loadSourceTree = async ({
  sourceKind,
  sourceRootPath,
  sourceLibraryType
}: {
  sourceKind: RekordboxSourceKind
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
}): Promise<IPioneerPlaylistTreeNode[]> => {
  if (sourceKind === 'desktop') {
    const result = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'load-tree')
    )) as { treeNodes?: IPioneerPlaylistTreeNode[] }
    return Array.isArray(result?.treeNodes) ? result.treeNodes : []
  }

  const rootPath = String(sourceRootPath || '').trim()
  if (!rootPath) return []
  const result = (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('usb', 'load-tree'),
    rootPath,
    sourceLibraryType || undefined
  )) as { treeNodes?: IPioneerPlaylistTreeNode[] }
  return Array.isArray(result?.treeNodes) ? result.treeNodes : []
}

/**
 * 从 rekordbox / U盘库导入精选艺人：只提取 {artist, filePath}，不复制任何音频文件。
 * 与 copyPioneerNodeToLibrary（物理复制）并列，是更轻量的"只记艺人"操作。
 */
export const importCuratedArtistsFromPioneerSource = async ({
  scope,
  node,
  sourceKind,
  sourceRootPath,
  sourceLibraryType,
  sourceName,
  runWithBusy,
  isBusy
}: ImportCuratedArtistsOptions): Promise<void> => {
  if (isBusy()) return
  if (sourceKind !== 'desktop' && sourceKind !== 'usb') return

  // 1. 确定要遍历的叶子播放列表集合
  let leafNodes: IPioneerPlaylistTreeNode[] = []
  let displayName = ''
  let isFolderScope = false

  if (scope === 'wholeLibrary') {
    const tree = await loadSourceTree({ sourceKind, sourceRootPath, sourceLibraryType })
    leafNodes = flattenPlayableNodes(tree)
    displayName = String(sourceName || '').trim()
  } else {
    if (!node) return
    if (node.isSmartPlaylist) return
    displayName = String(node.name || '').trim()
    if (node.isFolder) {
      isFolderScope = true
      leafNodes = flattenPlayableNodes(Array.isArray(node.children) ? node.children : [])
    } else {
      leafNodes = [node]
    }
  }

  if (!leafNodes.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('pioneer.importArtistsNoPlaylists')],
      confirmShow: false
    })
    return
  }

  // 2. 二次确认
  const confirmMessage =
    scope === 'wholeLibrary'
      ? t('pioneer.importArtistsWholeLibraryConfirm', {
          name: displayName || t('library.curated'),
          count: leafNodes.length
        })
      : isFolderScope
        ? t('pioneer.importArtistsFolderConfirm', {
            name: displayName,
            count: leafNodes.length
          })
        : t('pioneer.importArtistsSinglePlaylistConfirm', { name: displayName })
  const confirmResult = await confirm({
    title: t('pioneer.importArtistsToCuratedTitle'),
    content: [confirmMessage]
  })
  if (confirmResult !== 'confirm') return

  // 3. 遍历叶子歌单收集 {artistName, filePath}，最后一次性导入
  await runWithBusy(async () => {
    try {
      const tracksPayload: Array<{ artistName: string; filePath: string }> = []
      let failedPlaylistCount = 0

      for (const leaf of leafNodes) {
        const playlistId = Number(leaf.id) || 0
        if (playlistId <= 0) continue
        try {
          const loadResult = await loadRekordboxPlaylistTracks({
            sourceKind,
            playlistId,
            sourceRootPath,
            sourceLibraryType
          })
          const tracks = Array.isArray(loadResult?.tracks) ? loadResult.tracks : []
          for (const track of tracks) {
            const artistName = String(track?.artist || '').trim()
            const filePath = String(track?.filePath || '').trim()
            if (!artistName && !filePath) continue
            tracksPayload.push({ artistName, filePath })
          }
        } catch {
          failedPlaylistCount += 1
        }
      }

      if (!tracksPayload.length) {
        await confirm({
          title: t('pioneer.importArtistsFinishedTitle'),
          content: [t('pioneer.importArtistsNoTracks')],
          confirmShow: false
        })
        return
      }

      const result = (await window.electron.ipcRenderer.invoke('curatedArtists:importFromTracks', {
        tracks: tracksPayload
      })) as ImportCuratedArtistsResult

      const artistCount = Number(result?.count) || 0
      const importedTrackCount = Number(result?.importedTrackCount) || 0
      const fingerprintedTrackCount = Number(result?.fingerprintedTrackCount) || 0
      const artistOnlyTrackCount = Number(result?.artistOnlyTrackCount) || 0

      await confirm({
        title: t('pioneer.importArtistsFinishedTitle'),
        content: [
          t('pioneer.importArtistsSummaryCount', {
            artistCount,
            trackCount: importedTrackCount
          }),
          t('pioneer.importArtistsFingerprintBreakdown', {
            fingerprinted: fingerprintedTrackCount,
            artistOnly: artistOnlyTrackCount
          }),
          ...(failedPlaylistCount > 0
            ? [t('pioneer.importArtistsFailedPlaylistCount', { count: failedPlaylistCount })]
            : [])
        ],
        confirmShow: false
      })
    } catch (error: unknown) {
      await confirm({
        title: t('common.error'),
        content: [error instanceof Error ? error.message : String(error)],
        confirmShow: false
      })
    }
  })
}
