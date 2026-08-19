import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

const CHUNK_SIZE = 64

export function applyMissingFileFlags<T extends { rowKey?: string; fileMissing?: boolean }>(
  tracks: T[],
  sourceTracks: Array<{ rowKey?: string; fileMissing?: boolean }>
): T[] {
  const missingKeys = new Set(
    sourceTracks
      .filter((track) => track.fileMissing)
      .map((track) => String(track.rowKey || '').trim())
      .filter(Boolean)
  )
  if (!missingKeys.size) return tracks
  return tracks.map((track) =>
    missingKeys.has(String(track.rowKey || '').trim()) ? { ...track, fileMissing: true } : track
  )
}

export async function markMissingFiles(
  tracks: Array<{ filePath: string; fileMissing?: boolean }>
): Promise<void> {
  for (let i = 0; i < tracks.length; i += CHUNK_SIZE) {
    const chunk = tracks.slice(i, i + CHUNK_SIZE)
    await Promise.all(
      chunk.map(async (track) => {
        if (!track.filePath) {
          track.fileMissing = true
          return
        }
        try {
          await access(track.filePath, constants.R_OK)
        } catch {
          track.fileMissing = true
        }
      })
    )
  }
}
