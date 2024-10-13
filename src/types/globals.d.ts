declare interface IDir {
    "uuid": string,
    "type": "root" | "library" | "dir" | "songList",
    "dirName": string,
    "order": number
}