import fs = require('fs-extra')
import path = require('path')
import { v4 as uuidV4 } from 'uuid'
import { operateHiddenFile, ensureEnglishCoreLibraries } from './utils'

function hasSubdirectories(targetPath: fs.PathLike) {
  try {
    const items = fs.readdirSync(targetPath, { withFileTypes: true })
    for (const item of items) {
      if (item.isDirectory()) {
        return true
      }
    }
    return false
  } catch (_err) {
    return false
  }
}

export async function initDatabaseStructure(
  dirPath: string,
  options: { createSamples?: boolean } = {}
): Promise<void> {
  const createSamples = options.createSamples === true
  // 优先进行核心库中文→英文的重命名/归一化，避免先创建英文目录造成并存
  try {
    await ensureEnglishCoreLibraries(dirPath)
  } catch {}
  // 清理旧版 V1 指纹文件
  try {
    const v1 = path.join(dirPath, 'songFingerprint', 'songFingerprint.json')
    if (fs.pathExistsSync(v1)) {
      fs.removeSync(v1)
    }
  } catch {}

  // 根描述
  const rootDescription = {
    uuid: uuidV4(),
    type: 'root',
    order: 1
  }
  await operateHiddenFile(path.join(dirPath, 'library', '.description.json'), async () => {
    await fs.ensureDir(path.join(dirPath, 'library'))
    await fs.outputJson(path.join(dirPath, 'library', '.description.json'), rootDescription)
  })

  const makeLibrary = async (libraryPath: string, order: number) => {
    const descPath = path.join(libraryPath, '.description.json')
    if (!fs.pathExistsSync(descPath)) {
      const description = {
        uuid: uuidV4(),
        type: 'library',
        order
      }
      await operateHiddenFile(descPath, async () => {
        await fs.ensureDir(libraryPath)
        await fs.outputJson(descPath, description)
      })
    }
  }

  // 核心库目录改为英文命名，兼容旧库将在读取时尝试从中文重命名为英文
  const filterLibraryPath = path.join(dirPath, 'library/FilterLibrary')
  const curatedLibraryPath = path.join(dirPath, 'library/CuratedLibrary')
  const recycleBinPath = path.join(dirPath, 'library/RecycleBin')
  await makeLibrary(filterLibraryPath, 1)
  await makeLibrary(curatedLibraryPath, 2)
  await makeLibrary(recycleBinPath, 3)

  // 确保指纹目录存在（指纹文件由 healAndPrepare 负责创建）
  await fs.ensureDir(path.join(dirPath, 'songFingerprint'))

  // 仅在需要时（初始化向导）注入示例内容
  if (
    createSamples &&
    !hasSubdirectories(filterLibraryPath) &&
    !hasSubdirectories(curatedLibraryPath)
  ) {
    await operateHiddenFile(
      path.join(filterLibraryPath, 'House', '.description.json'),
      async () => {
        await fs.outputJson(path.join(filterLibraryPath, 'House', '.description.json'), {
          uuid: 'filterLibrarySonglistDemo1',
          type: 'songList',
          order: 1
        })
        const filterLibrarySonglistSongDemo1 = path
          .join(
            __dirname,
            '../../resources/demoMusic/Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
          )
          .replace('app.asar', 'app.asar.unpacked')
        const filterLibrarySonglistSongDemo2 = path
          .join(__dirname, '../../resources/demoMusic/War - Low Rider (Kyle Watson Remix).mp3')
          .replace('app.asar', 'app.asar.unpacked')
        if (fs.pathExistsSync(filterLibrarySonglistSongDemo1)) {
          await fs.copy(
            filterLibrarySonglistSongDemo1,
            path.join(
              filterLibraryPath,
              'House',
              'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
            )
          )
        }
        if (fs.pathExistsSync(filterLibrarySonglistSongDemo2)) {
          await fs.copy(
            filterLibrarySonglistSongDemo2,
            path.join(filterLibraryPath, 'House', 'War - Low Rider (Kyle Watson Remix).mp3')
          )
        }
      }
    )

    await operateHiddenFile(
      path.join(curatedLibraryPath, 'House Nice', '.description.json'),
      async () => {
        await fs.outputJson(path.join(curatedLibraryPath, 'House Nice', '.description.json'), {
          uuid: 'curatedLibrarySonglistDemo1',
          type: 'songList',
          order: 1
        })
        const curatedLibrarySonglistSongDemo1 = path
          .join(
            __dirname,
            '../../resources/demoMusic/Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
          )
          .replace('app.asar', 'app.asar.unpacked')
        if (fs.pathExistsSync(curatedLibrarySonglistSongDemo1)) {
          await fs.copy(
            curatedLibrarySonglistSongDemo1,
            path.join(
              curatedLibraryPath,
              'House Nice',
              'Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
            )
          )
        }
      }
    )
  }
}

export default { initDatabaseStructure }
