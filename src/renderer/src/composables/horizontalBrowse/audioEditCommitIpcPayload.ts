import { toIpcCloneablePayload } from '@renderer/utils/ipcCloneablePayload'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'

export type AudioEditCommitIpcInput = {
  sessionId: string
  sourceFilePath: string
  listRoot: string
  songListUUID: string
  target: 'overwrite' | 'new-version'
  outputFormat: 'original' | 'wav'
  clips: Array<{ sourceStartSec?: number; sourceEndSec?: number }>
  hotCues: unknown
  memoryCues: unknown
  title: string
  insertAfterFilePath: string
  existingNames: Array<string | null | undefined>
  orderedFilePaths: Array<string | null | undefined>
}

export const buildAudioEditCommitIpcPayload = (input: AudioEditCommitIpcInput) =>
  toIpcCloneablePayload({
    sessionId: String(input.sessionId || ''),
    sourceFilePath: String(input.sourceFilePath || ''),
    listRoot: String(input.listRoot || ''),
    songListUUID: String(input.songListUUID || ''),
    target: input.target === 'overwrite' ? 'overwrite' : 'new-version',
    outputFormat: input.outputFormat === 'wav' ? 'wav' : 'original',
    clips: (Array.isArray(input.clips) ? input.clips : []).map((clip) => ({
      sourceStartSec: Number(clip.sourceStartSec),
      sourceEndSec: Number(clip.sourceEndSec)
    })),
    hotCues: normalizeSongHotCues(input.hotCues),
    memoryCues: normalizeSongMemoryCues(input.memoryCues),
    title: String(input.title || ''),
    insertAfterFilePath: String(input.insertAfterFilePath || ''),
    existingNames: (Array.isArray(input.existingNames) ? input.existingNames : []).map((name) =>
      String(name || '')
    ),
    orderedFilePaths: (Array.isArray(input.orderedFilePaths) ? input.orderedFilePaths : []).map(
      (filePath) => String(filePath || '')
    )
  })
