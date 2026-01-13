import { t } from '@renderer/utils/translate'
import type { ISongInfo } from 'src/types/globals'

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value))

export function formatDeletedAtMs(value?: number | null): string {
  const ts = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return ''
  const year = date.getFullYear()
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  const hour = pad2(date.getHours())
  const minute = pad2(date.getMinutes())
  const second = pad2(date.getSeconds())
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

export function getRecycleBinSourceLabel(sourceType?: string | null): string {
  if (sourceType === 'external' || sourceType === 'import_dedup') {
    return t('recycleBin.externalSource')
  }
  return ''
}

export function getOriginalPlaylistDisplay(song: ISongInfo): string {
  const original = song?.originalPlaylistPath
  if (original) return String(original)
  return getRecycleBinSourceLabel(song?.recycleBinSourceType ?? null)
}
