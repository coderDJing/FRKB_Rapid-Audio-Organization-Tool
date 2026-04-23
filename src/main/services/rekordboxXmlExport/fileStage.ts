import fs from 'fs-extra'
import path from 'path'
import type { RekordboxXmlExportMode } from '../../../shared/rekordboxXmlExport'
import {
  RekordboxXmlExportAppliedOperation,
  RekordboxXmlExportResolvedTrack,
  RekordboxXmlExportStagedTrack
} from './types'
import { sanitizePathSegment } from './validate'

const throwIfCancelledInternal = (throwIfCancelled?: () => void) => {
  if (typeof throwIfCancelled === 'function') {
    throwIfCancelled()
  }
}

export const resolveUniqueDirectoryPath = async (targetRootDir: string, directoryName: string) => {
  const baseName = sanitizePathSegment(directoryName, 'FRKB Rekordbox Export')
  const initialPath = path.join(targetRootDir, baseName)
  if (!(await fs.pathExists(initialPath))) return initialPath
  let counter = 1
  while (true) {
    const candidate = path.join(targetRootDir, `${baseName} (${counter})`)
    if (!(await fs.pathExists(candidate))) return candidate
    counter += 1
  }
}

export const resolveUniqueFilePath = async (targetDirPath: string, fileName: string) => {
  const ext = path.extname(fileName)
  const baseName = sanitizePathSegment(path.basename(fileName, ext), 'track')
  const normalizedExt = ext || ''
  const initialPath = path.join(targetDirPath, `${baseName}${normalizedExt}`)
  if (!(await fs.pathExists(initialPath))) return initialPath
  let counter = 1
  while (true) {
    const candidate = path.join(targetDirPath, `${baseName} (${counter})${normalizedExt}`)
    if (!(await fs.pathExists(candidate))) return candidate
    counter += 1
  }
}

export const stageTrackFiles = async (params: {
  tracks: RekordboxXmlExportResolvedTrack[]
  exportDirPath: string
  mode: RekordboxXmlExportMode
  stagedTracks?: RekordboxXmlExportStagedTrack[]
  appliedOperations?: RekordboxXmlExportAppliedOperation[]
  throwIfCancelled?: () => void
  onTrackDone?: (done: number, total: number) => void | Promise<void>
}) => {
  const {
    tracks,
    exportDirPath,
    mode,
    stagedTracks = [],
    appliedOperations = [],
    throwIfCancelled,
    onTrackDone
  } = params

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    throwIfCancelledInternal(throwIfCancelled)
    const sourcePath = path.resolve(track.sourcePath)
    const sourceExt = path.extname(sourcePath)
    const fallbackName = path.basename(sourcePath, sourceExt)
    const preferredName = sanitizePathSegment(track.displayName || fallbackName, fallbackName)
    const outputPath = await resolveUniqueFilePath(exportDirPath, `${preferredName}${sourceExt}`)
    if (mode === 'move') {
      await fs.move(sourcePath, outputPath)
    } else {
      await fs.copy(sourcePath, outputPath)
    }
    stagedTracks.push({
      trackId: index + 1,
      sourcePath,
      outputPath,
      displayName: track.displayName || fallbackName,
      artist: track.artist,
      composer: track.composer,
      album: track.album,
      genre: track.genre,
      label: track.label,
      comment: track.comment,
      year: track.year,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      bitrate: track.bitrate,
      duration: track.duration,
      hotCues: track.hotCues,
      memoryCues: track.memoryCues
    })
    appliedOperations.push({
      mode,
      sourcePath,
      outputPath
    })
    if (typeof onTrackDone === 'function') {
      await onTrackDone(index + 1, tracks.length)
    }
  }

  return {
    stagedTracks,
    appliedOperations
  }
}

export const rollbackAppliedOperations = async (
  operations: RekordboxXmlExportAppliedOperation[]
): Promise<{ rolledBack: boolean; errors: string[] }> => {
  const errors: string[] = []
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]
    try {
      if (operation.mode === 'move') {
        const outputExists = await fs.pathExists(operation.outputPath)
        if (outputExists) {
          await fs.move(operation.outputPath, operation.sourcePath, { overwrite: false })
        }
      } else {
        await fs.remove(operation.outputPath)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'unknown error')
      errors.push(
        `${operation.mode}:${operation.outputPath} -> ${operation.sourcePath || '<empty>'}: ${message}`
      )
    }
  }
  return {
    rolledBack: errors.length === 0,
    errors
  }
}
