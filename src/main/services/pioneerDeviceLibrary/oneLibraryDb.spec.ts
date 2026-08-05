import { describe, expect, it } from 'vitest'
import {
  OneLibraryPlaylistNotFoundError,
  normalizeOneLibraryPlaylistTreeRows
} from './oneLibraryDb'

describe('normalizeOneLibraryPlaylistTreeRows', () => {
  it('preserves sequence number zero so the first playlist remains first', () => {
    const nodes = normalizeOneLibraryPlaylistTreeRows([
      { id: 121, parentId: 2, name: '无标题列表 (3)', attribute: 0, order: 0 },
      { id: 117, parentId: 2, name: '无标题列表 (1)', attribute: 0, order: 1 }
    ])

    expect(nodes.map((node) => ({ id: node.id, sortOrder: node.sortOrder }))).toEqual([
      { id: 121, sortOrder: 0 },
      { id: 117, sortOrder: 1 }
    ])
  })

  it('uses the row index only when the source does not provide an order', () => {
    const [node] = normalizeOneLibraryPlaylistTreeRows([
      { id: 121, parentId: 2, name: '无标题列表 (3)', attribute: 0 }
    ])

    expect(node?.sortOrder).toBe(0)
  })

  it('marks a PDB-only playlist as absent from the OneLibrary companion', () => {
    expect(new OneLibraryPlaylistNotFoundError(121)).toBeInstanceOf(OneLibraryPlaylistNotFoundError)
  })
})
