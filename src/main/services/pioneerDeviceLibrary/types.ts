export type PioneerDeviceLibraryProbe = {
  hasPioneerFolder: boolean
  hasRekordboxFolder: boolean
  hasExportPdb: boolean
  hasUsbAnlzFolder: boolean
  pioneerFolderPath: string | null
  rekordboxFolderPath: string | null
  exportPdbPath: string | null
  usbAnlzPath: string | null
}

export type PioneerRemovableDriveInfo = {
  id: string
  name: string
  path: string
  volumeName: string
  fileSystem: string
  size: number
  freeSpace: number
  driveType: number | null
  driveTypeLabel: string
  isUsb: boolean
  isRemovable: boolean
  isPioneerDeviceLibrary: boolean
  pioneer: PioneerDeviceLibraryProbe
}

export type PioneerDriveEjectFailureCode =
  | 'INVALID_PATH'
  | 'EJECT_COMMAND_FAILED'
  | 'EJECT_TIMEOUT'
  | 'UNSUPPORTED_PLATFORM'

export type PioneerDriveEjectResult = {
  success: boolean
  path: string
  code?: PioneerDriveEjectFailureCode
  detail?: string
}
