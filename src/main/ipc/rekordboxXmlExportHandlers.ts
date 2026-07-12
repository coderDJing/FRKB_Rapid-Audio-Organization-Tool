import { ipcMain } from 'electron'
import mainWindow from '../window/mainWindow'
import type {
  RekordboxXmlExportRequest,
  RekordboxXmlExportResponse
} from '../../shared/rekordboxXmlExport'
import {
  requestCancelRekordboxXmlExport,
  runRekordboxXmlExportJob
} from '../services/rekordboxXmlExport/execute'

export function registerRekordboxXmlExportHandlers() {
  ipcMain.handle(
    'rekordbox-xml-export:run',
    async (_event, request: RekordboxXmlExportRequest): Promise<RekordboxXmlExportResponse> => {
      return await runRekordboxXmlExportJob({
        request,
        control: { cancelled: false },
        reportProgress: (payload) => {
          mainWindow.instance?.webContents.send('progressSet', payload)
        }
      })
    }
  )

  ipcMain.handle('rekordbox-xml-export:cancel', async (_event, jobId: string) => {
    return requestCancelRekordboxXmlExport(jobId)
  })
}
