/// <reference types="electron-vite/node" />
import { ElectronAPI } from '@electron-toolkit/preload'
import { IPicture } from 'music-metadata'

interface IDir {
  uuid: string
  type: 'root' | 'library' | 'dir' | 'songList'
  dirName: string
  order?: number
  children?: IDir[]
}

type md5 = {
  md5_hash: string
  file_path: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {}
  }
}

interface ISongInfo {
  filePath: string
  cover: IPicture | null
  title: string | undefined
  artist: string | undefined
  album: string | undefined
  duration: string
  genre: string | undefined
  label: string | undefined
  bitrate: number | undefined
  container: string | undefined
}

interface ILayoutConfig {
  libraryAreaWidth: number
  isMaxMainWin: boolean
  mainWindowWidth: number
  mainWindowHeight: number
}

interface ISettingConfig {
  language: '' | 'enUS' | 'zhCN'
  audioExt: string[]
  databaseUrl: string
  globalCallShortcut: string
  nextCheckUpdateTime: string
}

interface ILanguageDict {
  [key: string]: {
    [key: string]: string | string[]
  }
}
interface IMenu {
  menuName: string
  shortcutKey?: string
}

interface IImportSongsFormData {
  filePaths?: string[]
  folderPath?: string[]
  songListPath: string
  isDeleteSourceFile: boolean
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
  songListUUID: string
}
export {
  md5,
  IDir,
  ISongInfo,
  ILayoutConfig,
  ISettingConfig,
  ILanguageDict,
  IMenu,
  IImportSongsFormData
}
