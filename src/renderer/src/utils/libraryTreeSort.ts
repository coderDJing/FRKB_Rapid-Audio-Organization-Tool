import { reactive, ref } from 'vue'
import type { IDir } from 'src/types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'

export type LibraryTreeSortRule = 'manual' | 'nameAsc' | 'nameDesc' | 'countAsc' | 'countDesc'

export const LIBRARY_TREE_SORT_RULES: LibraryTreeSortRule[] = [
  'manual',
  'nameAsc',
  'nameDesc',
  'countAsc',
  'countDesc'
]

const STORAGE_KEY = 'libraryTreeSortRules'

const isLibraryTreeSortRule = (value: unknown): value is LibraryTreeSortRule =>
  typeof value === 'string' && (LIBRARY_TREE_SORT_RULES as string[]).includes(value)

const loadRules = (): Record<string, LibraryTreeSortRule> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Record<string, LibraryTreeSortRule> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isLibraryTreeSortRule(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

const rulesByLibrary = ref<Record<string, LibraryTreeSortRule>>(loadRules())
/** 排序规则变更版本，供显示层 computed 依赖 */
export const libraryTreeSortRuleVersion = ref(0)
export const libraryTreeTrackCountMap = reactive<Record<string, number>>({})
/** 曲目数缓存变更版本，供显示层 computed 依赖 */
export const libraryTreeTrackCountVersion = ref(0)

const persistRules = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rulesByLibrary.value))
  } catch {
    // ignore quota / private mode failures
  }
}

export const getLibraryTreeSortRule = (libraryName: string): LibraryTreeSortRule => {
  const key = String(libraryName || '').trim()
  if (!key) return 'manual'
  return rulesByLibrary.value[key] || 'manual'
}

export const isLibraryTreeManualSort = (libraryName: string) =>
  getLibraryTreeSortRule(libraryName) === 'manual'

export const setLibraryTreeSortRule = (libraryName: string, rule: LibraryTreeSortRule) => {
  const key = String(libraryName || '').trim()
  if (!key || !isLibraryTreeSortRule(rule)) return
  if (rulesByLibrary.value[key] === rule) return
  rulesByLibrary.value = {
    ...rulesByLibrary.value,
    [key]: rule
  }
  libraryTreeSortRuleVersion.value += 1
  persistRules()
}

export const setLibraryTreeTrackCount = (uuid: string, count: number) => {
  const id = String(uuid || '').trim()
  if (!id) return
  const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (libraryTreeTrackCountMap[id] === next) return
  libraryTreeTrackCountMap[id] = next
  libraryTreeTrackCountVersion.value += 1
}

const isPlaylistNode = (node?: IDir | null) =>
  node?.type === 'songList' || node?.type === 'mixtapeList' || node?.type === 'setList'

export const getLibraryTreeNodeTrackCount = (node?: IDir | null): number => {
  if (!node) return 0
  if (isPlaylistNode(node)) {
    const cached = libraryTreeTrackCountMap[node.uuid]
    return typeof cached === 'number' ? cached : 0
  }
  if (node.type !== 'dir' || !node.children?.length) return 0
  let sum = 0
  for (const child of node.children) {
    sum += getLibraryTreeNodeTrackCount(child)
  }
  return sum
}

const compareName = (a: IDir, b: IDir, direction: 1 | -1) => {
  const left = String(a.dirName || '')
  const right = String(b.dirName || '')
  const byName = left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
  if (byName !== 0) return byName * direction
  return String(a.uuid).localeCompare(String(b.uuid)) * direction
}

const compareCount = (a: IDir, b: IDir, direction: 1 | -1) => {
  const left = getLibraryTreeNodeTrackCount(a)
  const right = getLibraryTreeNodeTrackCount(b)
  if (left !== right) return (left - right) * direction
  return compareName(a, b, 1)
}

export const sortLibraryTreeChildren = (
  children: IDir[] | undefined,
  rule: LibraryTreeSortRule
): IDir[] => {
  if (!children?.length) return []
  if (rule === 'manual') return children

  const pending = children.filter((item) => !String(item.dirName || '').trim())
  const named = children.filter((item) => String(item.dirName || '').trim())
  const sorted = [...named]

  if (rule === 'nameAsc') sorted.sort((a, b) => compareName(a, b, 1))
  else if (rule === 'nameDesc') sorted.sort((a, b) => compareName(a, b, -1))
  else if (rule === 'countAsc') sorted.sort((a, b) => compareCount(a, b, 1))
  else if (rule === 'countDesc') sorted.sort((a, b) => compareCount(a, b, -1))

  return pending.length ? [...pending, ...sorted] : sorted
}

export const collectPlaylistNodes = (root?: IDir | null): IDir[] => {
  const result: IDir[] = []
  const walk = (node?: IDir | null) => {
    if (!node) return
    if (isPlaylistNode(node)) result.push(node)
    if (node.children?.length) {
      for (const child of node.children) walk(child)
    }
  }
  walk(root)
  return result
}

let prefetchToken = 0

export const prefetchLibraryTreeTrackCounts = async (root?: IDir | null) => {
  const nodes = collectPlaylistNodes(root)
  if (!nodes.length) return
  const token = ++prefetchToken
  await Promise.all(
    nodes.map(async (node) => {
      if (token !== prefetchToken) return
      if (node.type === 'mixtapeList') {
        setLibraryTreeTrackCount(node.uuid, libraryTreeTrackCountMap[node.uuid] ?? 0)
        return
      }
      try {
        if (node.type === 'setList') {
          const count = await window.electron.ipcRenderer.invoke('setList:count', node.uuid)
          if (token !== prefetchToken) return
          setLibraryTreeTrackCount(node.uuid, typeof count === 'number' ? count : 0)
          return
        }
        const songListPath = libraryUtils.findDirPathByUuid(node.uuid)
        const count = await window.electron.ipcRenderer.invoke(
          'getSongListTrackCount',
          songListPath
        )
        if (token !== prefetchToken) return
        setLibraryTreeTrackCount(node.uuid, typeof count === 'number' ? count : 0)
      } catch {
        if (token !== prefetchToken) return
        setLibraryTreeTrackCount(node.uuid, 0)
      }
    })
  )
}

export const libraryTreeSortRuleLabelKey = (rule: LibraryTreeSortRule) => {
  switch (rule) {
    case 'manual':
      return 'playlist.sortRuleManual'
    case 'nameAsc':
      return 'playlist.sortRuleNameAsc'
    case 'nameDesc':
      return 'playlist.sortRuleNameDesc'
    case 'countAsc':
      return 'playlist.sortRuleCountAsc'
    case 'countDesc':
      return 'playlist.sortRuleCountDesc'
    default:
      return 'playlist.sortRuleManual'
  }
}

export const libraryTreeSortRuleMenuKey = (rule: LibraryTreeSortRule) => {
  switch (rule) {
    case 'manual':
      return 'playlist.sortMenuManual'
    case 'nameAsc':
      return 'playlist.sortMenuNameAsc'
    case 'nameDesc':
      return 'playlist.sortMenuNameDesc'
    case 'countAsc':
      return 'playlist.sortMenuCountAsc'
    case 'countDesc':
      return 'playlist.sortMenuCountDesc'
    default:
      return 'playlist.sortMenuManual'
  }
}
