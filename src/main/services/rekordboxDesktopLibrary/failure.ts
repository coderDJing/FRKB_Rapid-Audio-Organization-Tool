import { getLogPath, log } from '../../log'
import type { RekordboxDesktopPlaylistFailureSummary } from '../../../shared/rekordboxDesktopPlaylist'

const EXPECTED_FAILURE_CODES_WITHOUT_LOG = new Set(['REKORDBOX_DB_BUSY'])

const shouldWriteFailureLog = (errorCode: string) =>
  !EXPECTED_FAILURE_CODES_WITHOUT_LOG.has(String(errorCode || '').trim())

export const logRekordboxDesktopFailure = (
  message: string,
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
) => {
  if (!shouldWriteFailureLog(errorCode)) return
  log.error(message, {
    errorCode,
    errorMessage,
    ...details
  })
}

export const buildRekordboxDesktopFailureSummary = (
  errorCode: string,
  errorMessage: string
): RekordboxDesktopPlaylistFailureSummary => {
  const summary: RekordboxDesktopPlaylistFailureSummary = {
    errorCode,
    errorMessage
  }
  if (shouldWriteFailureLog(errorCode)) {
    summary.logPath = getLogPath()
  }
  return summary
}
