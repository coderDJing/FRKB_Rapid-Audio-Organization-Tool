import mainWindow from '../../window/mainWindow'
import { isLibraryRelocateActive } from './service'

export const openLibraryRelocateDialog = (): void => {
  if (isLibraryRelocateActive()) return
  mainWindow.instance?.webContents.send('library-relocate:open-dialog')
}
