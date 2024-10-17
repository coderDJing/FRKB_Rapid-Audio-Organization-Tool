/// <reference types="electron-vite/node" />

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
