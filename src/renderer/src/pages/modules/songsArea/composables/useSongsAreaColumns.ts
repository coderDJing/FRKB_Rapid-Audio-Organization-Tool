import { computed, ref, watch, type ShallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import { MIN_WIDTH_BY_KEY } from '../minWidth'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { getKeyDisplayText, getKeySortText } from '@shared/keyDisplay'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { getOriginalPlaylistDisplay } from '@renderer/utils/recycleBinDisplay'

interface UseSongsAreaColumnsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  originalSongInfoArr: ShallowRef<ISongInfo[]>
}

export function useSongsAreaColumns(params: UseSongsAreaColumnsParams) {
  const { runtime, originalSongInfoArr } = params

  // 统一额外初始宽度：在最小值基础上增加 40
  const INIT_EXTRA_WIDTH = 40
  const DEFAULT_STORAGE_KEY = 'songColumnData'
  const RECYCLE_STORAGE_KEY = 'recycleBinColumnData'

  const isRecycleBinView = computed(() => runtime.songsArea.songListUUID === RECYCLE_BIN_UUID)

  const buildBaseColumns = (isRecycleBin: boolean): Omit<ISongsAreaColumn, 'width'>[] => {
    const columns: Omit<ISongsAreaColumn, 'width'>[] = [
      { columnName: 'columns.index', key: 'index', show: true }
    ]
    if (isRecycleBin) {
      columns.push({
        columnName: 'columns.deletedAt',
        key: 'deletedAtMs',
        show: true,
        order: 'desc'
      })
    }
    columns.push(
      { columnName: 'columns.cover', key: 'cover', show: true },
      { columnName: 'columns.waveformPreview', key: 'waveformPreview', show: true },
      { columnName: 'columns.title', key: 'title', show: true, filterType: 'text' },
      {
        columnName: 'columns.artist',
        key: 'artist',
        show: true,
        filterType: 'text',
        order: isRecycleBin ? undefined : 'asc'
      }
    )
    if (isRecycleBin) {
      columns.push({
        columnName: 'columns.originalPlaylist',
        key: 'originalPlaylistPath',
        show: true,
        filterType: 'text'
      })
    }
    columns.push(
      { columnName: 'columns.duration', key: 'duration', show: true, filterType: 'duration' },
      { columnName: 'columns.bpm', key: 'bpm', show: true, filterType: 'bpm' },
      { columnName: 'columns.key', key: 'key', show: true, filterType: 'text' },
      { columnName: 'columns.album', key: 'album', show: true, filterType: 'text' },
      { columnName: 'columns.label', key: 'label', show: true, filterType: 'text' },
      { columnName: 'columns.genre', key: 'genre', show: true, filterType: 'text' },
      { columnName: 'columns.fileFormat', key: 'fileFormat', show: true, filterType: 'text' },
      { columnName: 'columns.bitrate', key: 'bitrate', show: true },
      { columnName: 'columns.fileName', key: 'fileName', show: true, filterType: 'text' },
      { columnName: 'columns.format', key: 'container', show: true, filterType: 'text' }
    )
    return columns
  }

  const buildDefaultColumns = (isRecycleBin: boolean): ISongsAreaColumn[] =>
    buildBaseColumns(isRecycleBin).map((col) => ({
      ...col,
      width: (MIN_WIDTH_BY_KEY[col.key] ?? 0) + INIT_EXTRA_WIDTH
    }))

  const loadColumnsFromStorage = (isRecycleBin: boolean): ISongsAreaColumn[] => {
    const storageKey = isRecycleBin ? RECYCLE_STORAGE_KEY : DEFAULT_STORAGE_KEY
    const defaultColumns = buildDefaultColumns(isRecycleBin)
    const savedData = localStorage.getItem(storageKey)
    let finalColumns: ISongsAreaColumn[]

    if (!savedData) {
      finalColumns = JSON.parse(JSON.stringify(defaultColumns))
    } else {
      try {
        const parsedSavedColumns: ISongsAreaColumn[] = JSON.parse(savedData)
        const defaultColumnsMap = new Map(defaultColumns.map((col) => [col.key, col]))

        finalColumns = parsedSavedColumns
          .map((savedCol) => {
            const defaultCol = defaultColumnsMap.get(savedCol.key)
            if (defaultCol) {
              const mergedCol = {
                ...defaultCol,
                show: savedCol.show !== undefined ? savedCol.show : defaultCol.show,
                width: savedCol.width !== undefined ? savedCol.width : defaultCol.width,
                order: (Object.prototype.hasOwnProperty.call(savedCol, 'order')
                  ? savedCol.order
                  : undefined) as ISongsAreaColumn['order'],
                key: defaultCol.key,
                columnName: defaultCol.columnName,
                filterType: defaultCol.filterType,
                filterActive:
                  (runtime.setting.persistSongFilters ? savedCol.filterActive : false) ?? false,
                filterValue: runtime.setting.persistSongFilters ? savedCol.filterValue : undefined,
                filterOp: runtime.setting.persistSongFilters ? savedCol.filterOp : undefined,
                filterDuration: runtime.setting.persistSongFilters
                  ? savedCol.filterDuration
                  : undefined,
                filterNumber: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterNumber
                  : undefined
              }
              return mergedCol
            }
            return null
          })
          .filter((col) => col !== null) as ISongsAreaColumn[]

        defaultColumns.forEach((defaultCol) => {
          if (!finalColumns.some((fc) => fc.key === defaultCol.key)) {
            finalColumns.push(JSON.parse(JSON.stringify(defaultCol)))
          }
        })

        finalColumns = finalColumns.filter((fc) => defaultColumnsMap.has(fc.key))
      } catch (error) {
        console.error(`解析本地存储的 ${storageKey} 出错，使用默认列配置:`, error)
        finalColumns = JSON.parse(JSON.stringify(defaultColumns))
      }
    }

    const hasOrderAfterMerge = finalColumns.some((col) => col.order !== undefined)
    if (!hasOrderAfterMerge) {
      if (isRecycleBin) {
        const deletedAtIndex = finalColumns.findIndex((col) => col.key === 'deletedAtMs')
        if (deletedAtIndex !== -1) {
          finalColumns[deletedAtIndex] = {
            ...finalColumns[deletedAtIndex],
            order: 'desc'
          }
        }
      } else {
        const durationColIndex = finalColumns.findIndex((col) => col.key === 'duration')
        if (durationColIndex !== -1) {
          finalColumns[durationColIndex] = { ...finalColumns[durationColIndex], order: 'asc' }
        } else {
          const titleColIndex = finalColumns.findIndex((col) => col.key === 'title')
          if (titleColIndex !== -1) {
            finalColumns[titleColIndex] = { ...finalColumns[titleColIndex], order: 'asc' }
          }
        }
      }
    }

    finalColumns = finalColumns.map((col) => {
      const minWidth = MIN_WIDTH_BY_KEY[col.key] ?? col.width
      if (col.width < minWidth) {
        return { ...col, width: minWidth }
      }
      return col
    })

    return finalColumns
  }

  const columnData = ref<ISongsAreaColumn[]>(loadColumnsFromStorage(isRecycleBinView.value))

  // --- 工具 ---
  function sortArrayByProperty<T>(
    array: T[],
    property: keyof T,
    order: 'asc' | 'desc' = 'asc'
  ): T[] {
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
    return [...array].sort((a, b) => {
      const valueA = String((a as any)[property] || '')
      const valueB = String((b as any)[property] || '')
      return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
    })
  }

  function parseDurationToSeconds(mmss: string): number {
    if (!mmss || typeof mmss !== 'string') return NaN
    const parts = mmss.split(':')
    if (parts.length !== 2) return NaN
    const m = Number(parts[0])
    const s = Number(parts[1])
    if (Number.isNaN(m) || Number.isNaN(s)) return NaN
    return m * 60 + s
  }

  function parseNumberInput(input: unknown): number {
    if (input === null || input === undefined) return NaN
    if (typeof input === 'number') {
      return Number.isFinite(input) ? input : NaN
    }
    const raw = String(input || '').trim()
    if (!raw) return NaN
    const cleaned = raw.replace(/[^0-9.]/g, '')
    if (!cleaned) return NaN
    const parts = cleaned.split('.')
    const normalized = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
    const num = Number(normalized)
    return Number.isFinite(num) ? num : NaN
  }

  // --- 持久化 ---
  const persistColumnData = () => {
    const storageKey = isRecycleBinView.value ? RECYCLE_STORAGE_KEY : DEFAULT_STORAGE_KEY
    localStorage.setItem(storageKey, JSON.stringify(columnData.value))
  }

  // --- 根据列筛选过滤并按当前排序排序 ---
  function applyFiltersAndSorting() {
    let filtered = [...originalSongInfoArr.value]
    runtime.songsArea.totalSongCount = filtered.length
    for (const col of columnData.value) {
      if (!col.filterActive) continue
      if (col.filterType === 'text' && col.filterValue && col.key) {
        const keyword = String(col.filterValue).toLowerCase()
        const isKeyColumn = col.key === 'key'
        const isOriginalPlaylist = col.key === 'originalPlaylistPath'
        const keyStyle =
          (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
        filtered = filtered.filter((song) => {
          const rawValue = isOriginalPlaylist
            ? getOriginalPlaylistDisplay(song)
            : String((song as any)[col.key] ?? '')
          const displayValue = isKeyColumn ? getKeyDisplayText(rawValue, keyStyle) : rawValue
          const value = displayValue.toLowerCase()
          return value.includes(keyword)
        })
      } else if (col.filterType === 'duration' && col.filterOp && col.filterDuration) {
        const target = parseDurationToSeconds(col.filterDuration)
        filtered = filtered.filter((song) => {
          const dur = parseDurationToSeconds(String((song as any)['duration'] ?? ''))
          if (Number.isNaN(dur) || Number.isNaN(target)) return false
          if (col.filterOp === 'eq') return dur === target
          if (col.filterOp === 'gte') return dur >= target
          if (col.filterOp === 'lte') return dur <= target
          return true
        })
      } else if (col.filterType === 'bpm' && col.filterOp && col.filterNumber) {
        const target = parseNumberInput(col.filterNumber)
        filtered = filtered.filter((song) => {
          const bpm = parseNumberInput((song as any)?.bpm)
          if (Number.isNaN(bpm) || Number.isNaN(target)) return false
          if (col.filterOp === 'eq') return bpm === target
          if (col.filterOp === 'gte') return bpm >= target
          if (col.filterOp === 'lte') return bpm <= target
          return true
        })
      }
    }

    const sortedCol = columnData.value.find((c) => c.order)
    if (sortedCol) {
      if (sortedCol.key === 'key') {
        const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
        filtered = [...filtered].sort((a, b) => {
          const valueA = getKeySortText(String((a as any).key || ''), style)
          const valueB = getKeySortText(String((b as any).key || ''), style)
          const emptyA = valueA.trim() === ''
          const emptyB = valueB.trim() === ''
          if (emptyA && emptyB) return 0
          if (emptyA) return 1
          if (emptyB) return -1
          return sortedCol.order === 'asc'
            ? collator.compare(valueA, valueB)
            : collator.compare(valueB, valueA)
        })
      } else if (sortedCol.key === 'deletedAtMs') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = Number((a as any).deletedAtMs)
          const valueB = Number((b as any).deletedAtMs)
          const validA = Number.isFinite(valueA)
          const validB = Number.isFinite(valueB)
          if (!validA && !validB) return 0
          if (!validA) return 1
          if (!validB) return -1
          return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
        })
      } else if (sortedCol.key === 'originalPlaylistPath') {
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
        filtered = [...filtered].sort((a, b) => {
          const valueA = getOriginalPlaylistDisplay(a).trim()
          const valueB = getOriginalPlaylistDisplay(b).trim()
          const emptyA = valueA === ''
          const emptyB = valueB === ''
          if (emptyA && emptyB) return 0
          if (emptyA) return 1
          if (emptyB) return -1
          return sortedCol.order === 'asc'
            ? collator.compare(valueA, valueB)
            : collator.compare(valueB, valueA)
        })
      } else {
        filtered = sortArrayByProperty<ISongInfo>(
          filtered,
          sortedCol.key as keyof ISongInfo,
          sortedCol.order!
        )
      }
    }

    // 防御性去重：以 filePath 为键去重，避免竞态下重复条目影响渲染与选择
    const seen = new Set<string>()
    filtered = filtered.filter((item) => {
      const p = (item as any)?.filePath
      if (!p) return false
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })

    runtime.songsArea.songInfoArr = filtered
  }

  // --- 列更新 ---
  const handleColumnsUpdate = (newColumns: ISongsAreaColumn[]) => {
    columnData.value = newColumns
    persistColumnData()
    applyFiltersAndSorting()
    runtime.songsArea.selectedSongFilePath.length = 0
  }

  watch(
    () => isRecycleBinView.value,
    () => {
      columnData.value = loadColumnsFromStorage(isRecycleBinView.value)
      applyFiltersAndSorting()
    }
  )

  watch(
    () => (runtime.setting as any).keyDisplayStyle,
    () => {
      const sortedCol = columnData.value.find((c) => c.order)
      const hasKeyFilter = columnData.value.some((c) => c.key === 'key' && c.filterActive)
      if (sortedCol?.key === 'key' || hasKeyFilter) {
        applyFiltersAndSorting()
      }
    }
  )

  // --- 右键菜单与可见性切换 ---
  const colRightClickMenuShow = ref(false)
  const triggeringColContextEvent = ref<MouseEvent | null>(null)
  const contextmenuEvent = (event: MouseEvent) => {
    triggeringColContextEvent.value = event
    colRightClickMenuShow.value = true
  }

  const handleToggleColumnVisibility = (columnKey: string) => {
    const columnIndex = columnData.value.findIndex((col) => col.key === columnKey)
    if (columnIndex !== -1) {
      const newColumns = columnData.value.map((col, index) => {
        if (index === columnIndex) {
          return { ...col, show: !col.show }
        }
        return col
      })
      columnData.value = newColumns
      persistColumnData()
    }
  }

  // --- 列头排序点击 ---
  const colMenuClick = (col: ISongsAreaColumn) => {
    if (col.key === 'index' || col.key === 'cover' || col.key === 'waveformPreview') return

    const newColumnData = columnData.value.map((item) => {
      if (item.key !== col.key) {
        return { ...item, order: undefined }
      }
      const newOrderForItem = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
      return { ...item, order: newOrderForItem as 'asc' | 'desc' }
    })
    columnData.value = newColumnData.map((c) =>
      c.key === 'cover' ? { ...c, order: undefined } : c
    )
    persistColumnData()
    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }
  }

  const columnDataArr = computed(() => columnData.value.filter((item) => item.show))

  const totalColumnsWidth = computed(() => {
    if (!columnDataArr.value || columnDataArr.value.length === 0) return 0
    return columnDataArr.value.reduce((sum, col) => sum + (col.width || 0), 0)
  })

  return {
    columnData,
    columnDataArr,
    totalColumnsWidth,
    colRightClickMenuShow,
    triggeringColContextEvent,
    contextmenuEvent,
    handleToggleColumnVisibility,
    handleColumnsUpdate,
    colMenuClick,
    applyFiltersAndSorting
  }
}
