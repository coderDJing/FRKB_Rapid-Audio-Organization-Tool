import type { IDir } from 'src/types/globals'

export type DialogNavArea = 'recent' | 'tree'
export type DialogNavItem = { uuid: string; area: DialogNavArea }
const RECENT_DIALOG_SELECTED_SONGLIST_KEY_PREFIX = 'recentDialogSelectedSongListUUID'

const resolveRecentDialogSelectedSongListStorageKey = (libraryName: string) =>
  `${RECENT_DIALOG_SELECTED_SONGLIST_KEY_PREFIX}${libraryName}`

const filterSongListsByKeyword = (songLists: IDir[], keyword: string) => {
  const safeKeyword = String(keyword || '')
    .trim()
    .toLowerCase()
  if (!safeKeyword) return songLists
  return songLists.filter((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(safeKeyword)
  )
}

export const buildVisibleCombinedNavList = (
  recentSongLists: IDir[],
  allSongLists: IDir[],
  keyword: string
): DialogNavItem[] => {
  const visibleRecent = filterSongListsByKeyword(recentSongLists, keyword)
  const visibleAll = filterSongListsByKeyword(allSongLists, keyword)
  const list: DialogNavItem[] = []
  for (const item of visibleRecent) list.push({ uuid: item.uuid, area: 'recent' })
  for (const item of visibleAll) list.push({ uuid: item.uuid, area: 'tree' })
  return list
}

export const resolveDialogNavIndexByUUID = (
  list: DialogNavItem[],
  selectedUuid: string,
  selectedArea: DialogNavArea | ''
) => {
  if (!selectedUuid) return -1
  let index = list.findIndex((item) => item.uuid === selectedUuid && item.area === selectedArea)
  if (index >= 0) return index
  index = list.findIndex((item) => item.uuid === selectedUuid)
  return index
}

export const resolveDialogNavMove = (
  currentIndex: number,
  direction: 1 | -1,
  listLength: number
) => {
  if (listLength <= 0) return -1
  if (currentIndex < 0) return 0
  return (currentIndex + direction + listLength) % listLength
}

export const loadRecentDialogSelectedSongListUUIDs = (
  libraryName: string,
  maxCount: number
): string[] => {
  const rawValue = localStorage.getItem(resolveRecentDialogSelectedSongListStorageKey(libraryName))
  if (!rawValue) return []
  const parsed = JSON.parse(rawValue)
  if (!Array.isArray(parsed)) return []
  const normalized = parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  const safeMaxCount = Math.max(1, Math.floor(Number(maxCount) || 10))
  if (normalized.length <= safeMaxCount) return normalized
  const next = normalized.slice(0, safeMaxCount)
  persistRecentDialogSelectedSongListUUIDs(libraryName, next)
  return next
}

export const persistRecentDialogSelectedSongListUUIDs = (libraryName: string, uuids: string[]) => {
  localStorage.setItem(
    resolveRecentDialogSelectedSongListStorageKey(libraryName),
    JSON.stringify(uuids)
  )
}
