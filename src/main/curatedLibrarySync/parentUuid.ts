import { CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID } from '../../shared/curatedLibrarySync'

export const toCloudParentUuid = (parentUuid: string, curatedUuid: string): string =>
  parentUuid === curatedUuid ? CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID : parentUuid

export const resolveCloudParentToLocalUuid = (
  cloudParentUuid: string,
  curatedUuid: string,
  snapshotNodeIds: Set<string>
): string => {
  const parent = String(cloudParentUuid || '').trim()
  if (
    !parent ||
    parent === curatedUuid ||
    parent === CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID ||
    !snapshotNodeIds.has(parent)
  ) {
    return curatedUuid
  }
  return parent
}

export const canonicalizeCloudParentUuid = (
  parentUuid: string,
  curatedUuid: string,
  snapshotNodeIds: Set<string>
): string =>
  toCloudParentUuid(
    resolveCloudParentToLocalUuid(parentUuid, curatedUuid, snapshotNodeIds),
    curatedUuid
  )

export const sameCloudParentUuid = (
  left: string,
  right: string,
  curatedUuid: string,
  snapshotNodeIds: Set<string>
): boolean =>
  canonicalizeCloudParentUuid(left, curatedUuid, snapshotNodeIds) ===
  canonicalizeCloudParentUuid(right, curatedUuid, snapshotNodeIds)
