import type { SqliteDatabase } from './libraryDb'
import type { LibraryNodeRow } from './libraryTreeDbHelpers'

let cachedDb: SqliteDatabase | null = null
let cachedRows: readonly LibraryNodeRow[] | null = null

export const readLibraryNodeCache = (db: SqliteDatabase): readonly LibraryNodeRow[] | null => {
  if (cachedDb !== db || !cachedRows) return null
  return cachedRows
}

export const writeLibraryNodeCache = (
  db: SqliteDatabase,
  rows: readonly LibraryNodeRow[]
): void => {
  cachedDb = db
  cachedRows = rows
}

/** 节点写入后必须清掉，否则路径解析会继续用旧树。返回的数组是共享的，调用方不能原地修改。 */
export const invalidateLibraryNodeCache = (): void => {
  cachedDb = null
  cachedRows = null
}
