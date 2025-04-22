/// <reference types="electron-vite/node" />
import { ElectronAPI } from '@electron-toolkit/preload'
import { PreloadApi } from '../preload/index'
import { IPicture } from 'music-metadata'

interface IDir {
  uuid: string
  type: 'root' | 'library' | 'dir' | 'songList'
  dirName: string
  order?: number
  children?: IDir[]
}

type md5 = {
  sha256_Hash: string
  file_path: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
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
  coverUrl?: string
}

interface ILayoutConfig {
  libraryAreaWidth: number
  isMaxMainWin: boolean
  mainWindowWidth: number
  mainWindowHeight: number
}

interface ISettingConfig {
  platform: 'win32' | 'darwin'
  language: '' | 'enUS' | 'zhCN'
  audioExt: string[]
  databaseUrl: string
  globalCallShortcut: string
  nextCheckUpdateTime: string
  hiddenPlayControlArea: boolean
  fastForwardTime: number
  fastBackwardTime: number
  autoScrollToCurrentSong: boolean
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

interface ISongsAreaColumn {
  columnName: string
  key: string
  show: boolean
  width: number
  order?: 'asc' | 'desc'
}

type Icon = {
  name: '筛选库' | '精选库' | '回收站'
  grey: string
  white: string
  src: string
  showAlt: boolean
}
export {
  md5,
  IDir,
  ISongInfo,
  ILayoutConfig,
  ISettingConfig,
  ILanguageDict,
  IMenu,
  IImportSongsFormData,
  ISongsAreaColumn,
  Icon
}
