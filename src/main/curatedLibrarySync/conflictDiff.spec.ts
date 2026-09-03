import { describe, expect, it } from 'vitest'
import { collectDroppedOps } from './conflictDiff'
import type { CuratedLibrarySyncSnapshot } from '../../shared/curatedLibrarySync'

const snapshot = (): CuratedLibrarySyncSnapshot => ({
  protocolVersion: 1,
  revision: 4,
  snapshotReady: true,
  nodes: [
    {
      uuid: '11111111-1111-4111-8111-111111111111',
      parentUuid: '00000000-0000-4000-8000-000000000000',
      name: 'Cloud House',
      nodeType: 'songList',
      sortOrder: 0,
      updatedAtMs: 4
    }
  ],
  files: [
    {
      fileId: '22222222-2222-4222-8222-222222222222',
      parentUuid: '11111111-1111-4111-8111-111111111111',
      fileName: 'cloud.mp3',
      sha256: 'b'.repeat(64),
      size: 10,
      trackNumber: 2,
      addedAtMs: 1,
      updatedAtMs: 4
    }
  ],
  tombstones: []
})

describe('collectDroppedOps', () => {
  it('本机移动被云端位置覆盖时记为冲突', () => {
    const items = collectDroppedOps(
      [
        {
          type: 'upsertFile',
          file: {
            fileId: '22222222-2222-4222-8222-222222222222',
            parentUuid: '33333333-3333-4333-8333-333333333333',
            fileName: 'cloud.mp3',
            sha256: 'b'.repeat(64),
            size: 10,
            trackNumber: 2,
            addedAtMs: 1,
            updatedAtMs: 5
          }
        }
      ],
      snapshot()
    )
    expect(items).toEqual([{ kind: 'file-move-lost', name: 'cloud.mp3' }])
  })

  it('本机删除但云端仍在时记为冲突', () => {
    const items = collectDroppedOps(
      [
        {
          type: 'deleteFile',
          fileId: '22222222-2222-4222-8222-222222222222',
          updatedAtMs: 5
        }
      ],
      snapshot()
    )
    expect(items[0]?.kind).toBe('file-delete-lost')
  })

  it('与云端一致的推送不算冲突', () => {
    const cloud = snapshot().files[0]
    const items = collectDroppedOps(
      [
        {
          type: 'upsertFile',
          file: cloud
        }
      ],
      snapshot()
    )
    expect(items).toEqual([])
  })
})
