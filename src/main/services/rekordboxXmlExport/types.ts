import type {
  RekordboxXmlExportMode,
  RekordboxXmlExportRequest
} from '../../../shared/rekordboxXmlExport'

export const REKORDBOX_XML_EXPORT_CANCELLED = 'REKORDBOX_XML_EXPORT_CANCELLED'

export class RekordboxXmlExportCancelledError extends Error {
  code: string

  constructor(message = '用户取消了 Rekordbox XML 导出') {
    super(message)
    this.name = 'RekordboxXmlExportCancelledError'
    this.code = REKORDBOX_XML_EXPORT_CANCELLED
  }
}

export type RekordboxXmlExportJobControl = {
  cancelled: boolean
}

export type RekordboxXmlExportResolvedTrack = {
  sourcePath: string
  displayName: string
  artist?: string
  composer?: string
  album?: string
  genre?: string
  label?: string
  comment?: string
  year?: string
  trackNumber?: number
  discNumber?: number
  bitrate?: number
  duration?: string
}

export type RekordboxXmlExportStagedTrack = {
  trackId: number
  sourcePath: string
  outputPath: string
  displayName: string
  artist?: string
  composer?: string
  album?: string
  genre?: string
  label?: string
  comment?: string
  year?: string
  trackNumber?: number
  discNumber?: number
  bitrate?: number
  duration?: string
}

export type RekordboxXmlExportAppliedOperation = {
  mode: RekordboxXmlExportMode
  sourcePath: string
  outputPath: string
}

export type RekordboxXmlExportProgressPayload = {
  id: string
  titleKey: string
  now: number
  total: number
  isInitial?: boolean
  dismiss?: boolean
  cancelable?: boolean
  cancelChannel?: string
  cancelPayload?: unknown
}

export type RekordboxXmlExportProgressReporter = (
  payload: RekordboxXmlExportProgressPayload
) => void | Promise<void>

export type RekordboxXmlExportRunOptions = {
  request: RekordboxXmlExportRequest
  control: RekordboxXmlExportJobControl
  reportProgress?: RekordboxXmlExportProgressReporter
}
