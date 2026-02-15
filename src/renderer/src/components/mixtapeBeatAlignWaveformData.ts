import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

export const isValidMixxxWaveformData = (
  data: MixxxWaveformData | null
): data is MixxxWaveformData => {
  if (!data) return false
  const low = data.bands?.low
  const mid = data.bands?.mid
  const high = data.bands?.high
  const all = data.bands?.all
  if (!low || !mid || !high || !all) return false

  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
  if (!frameCount) return false

  const isMatch = (arr?: Uint8Array) => (!arr ? true : arr.length === frameCount)
  return (
    isMatch(low.peakLeft) &&
    isMatch(low.peakRight) &&
    isMatch(mid.peakLeft) &&
    isMatch(mid.peakRight) &&
    isMatch(high.peakLeft) &&
    isMatch(high.peakRight) &&
    isMatch(all.peakLeft) &&
    isMatch(all.peakRight)
  )
}

export const pickMixxxDataByFile = (
  response: any,
  fileKey: string,
  normalizePathKey: (value: unknown) => string
): MixxxWaveformData | null => {
  const items = Array.isArray(response?.items) ? response.items : []
  const item = items.find((entry: any) => normalizePathKey(entry?.filePath) === fileKey)
  const data = (item?.data ?? null) as MixxxWaveformData | null
  return isValidMixxxWaveformData(data) ? data : null
}
