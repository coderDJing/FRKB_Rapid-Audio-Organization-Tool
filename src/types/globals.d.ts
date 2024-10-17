/// <reference types="electron-vite/node" />
import { ElectronAPI } from '@electron-toolkit/preload'

declare interface IDir {
  uuid: string
  type: 'root' | 'library' | 'dir' | 'songList'
  dirName: string
  order: number
}

type md5 = {
  md5_hash: string
  file_path: string
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {};
  }
}

export { md5, IDir };