import { describe, expect, it } from 'vitest'
import { CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID } from '../../shared/curatedLibrarySync'
import {
  canonicalizeCloudParentUuid,
  resolveCloudParentToLocalUuid,
  sameCloudParentUuid,
  toCloudParentUuid
} from './parentUuid'

const LOCAL_CURATED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_CURATED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PLAYLIST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const snapshotNodeIds = new Set([PLAYLIST])

describe('精选库云同步父节点映射', () => {
  it('扫描时把本机精选库根改写成哨兵 UUID', () => {
    expect(toCloudParentUuid(LOCAL_CURATED, LOCAL_CURATED)).toBe(
      CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID
    )
    expect(toCloudParentUuid(PLAYLIST, LOCAL_CURATED)).toBe(PLAYLIST)
  })

  it('落地时把哨兵和对方精选库根都映射到本机精选库', () => {
    expect(
      resolveCloudParentToLocalUuid(
        CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
        LOCAL_CURATED,
        snapshotNodeIds
      )
    ).toBe(LOCAL_CURATED)
    expect(resolveCloudParentToLocalUuid(OTHER_CURATED, LOCAL_CURATED, snapshotNodeIds)).toBe(
      LOCAL_CURATED
    )
    expect(resolveCloudParentToLocalUuid(PLAYLIST, LOCAL_CURATED, snapshotNodeIds)).toBe(PLAYLIST)
  })

  it('比较时旧云端根 UUID 与哨兵视为同一父节点', () => {
    expect(
      sameCloudParentUuid(
        OTHER_CURATED,
        CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
        LOCAL_CURATED,
        snapshotNodeIds
      )
    ).toBe(true)
    expect(canonicalizeCloudParentUuid(OTHER_CURATED, LOCAL_CURATED, snapshotNodeIds)).toBe(
      CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID
    )
  })
})
