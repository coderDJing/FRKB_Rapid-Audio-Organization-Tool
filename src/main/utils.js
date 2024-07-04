import { join } from 'path'
const fs = require('fs-extra')

async function getdirsDescriptionJson(dirPath, dirs) {
  const jsons = await Promise.all(dirs.map(async (dir) => {
    const filePath = join(dirPath, dir.name, 'description.json');
    const json = await fs.readJSON(filePath);
    const subDirPath = join(dirPath, dir.name);
    const subEntries = await fs.readdir(subDirPath, { withFileTypes: true });
    const subDirs = subEntries.filter(entry => entry.isDirectory());
    const subJsons = await getdirsDescriptionJson(subDirPath, subDirs);
    json.children = subJsons;
    return json;
  }));

  return jsons.sort((a, b) => a.order - b.order);
}

//获取整个库的树结构
export async function getLibrary() {
  const dirPath = join(__dirname, 'library');
  const rootDescriptionJson = await fs.readJSON(join(dirPath, 'description.json'));
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory());
  const dirsDescriptionJson = await getdirsDescriptionJson(dirPath, dirs);
  rootDescriptionJson.children = dirsDescriptionJson;
  return rootDescriptionJson;
}


// 异步函数，用于读取和更新 description.json 文件中的 order 属性
async function updateOrderInFile(filePath, type) {
  try {
    const jsonObj = await fs.readJSON(filePath);
    if (type == 'minus') {
      jsonObj.order--;
    } else {
      jsonObj.order++;
    }
    await fs.outputJson(filePath, jsonObj);
  } catch (error) {
    console.error(`Error updating ${filePath}:`, error);
  }
}
// 异步函数，用于遍历目录并处理 description.json 文件中的order大于参数orderNum时-1
export const updateTargetDirSubdirOrderAfterNumMinus = async (dirPath, orderNum) => {
  try {
    const subdirs = await fs.readdir(dirPath, { withFileTypes: true });
    const dirs = subdirs.filter(dirent => dirent.isDirectory());
    const promises = [];
    for (const dirent of dirs) {
      const subdirPath = join(dirPath, dirent.name);
      const descriptionJsonPath = join(subdirPath, 'description.json');
      let description = await fs.readJSON(descriptionJsonPath)
      if (description.order > orderNum) {
        promises.push(updateOrderInFile(descriptionJsonPath, 'minus'));
      }
    }
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error);
  }
}

// 异步函数，用于遍历目录并处理 description.json 文件中的order小于参数orderNum时+1
export const updateTargetDirSubdirOrderBeforeNumPlus = async (dirPath, orderNum) => {
  try {
    const subdirs = await fs.readdir(dirPath, { withFileTypes: true });
    const dirs = subdirs.filter(dirent => dirent.isDirectory());
    const promises = [];
    for (const dirent of dirs) {
      const subdirPath = join(dirPath, dirent.name);
      const descriptionJsonPath = join(subdirPath, 'description.json');
      let description = await fs.readJSON(descriptionJsonPath)
      if (description.order < orderNum) {
        promises.push(updateOrderInFile(descriptionJsonPath));
      }
    }
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error);
  }
}
// 异步函数，用于遍历目录并处理 description.json 文件中的order++
export const updateTargetDirSubdirOrder = async (dirPath) => {
  try {
    // 读取目录内容
    const subdirs = await fs.readdir(dirPath, { withFileTypes: true });

    // 过滤出子文件夹
    const dirs = subdirs.filter(dirent => dirent.isDirectory());

    // 初始化一个用于存储 Promise 的数组
    const promises = [];

    // 遍历每个子文件夹
    for (const dirent of dirs) {
      const subdirPath = join(dirPath, dirent.name);
      const descriptionJsonPath = join(subdirPath, 'description.json');

      // 添加一个 Promise 到数组中以并发处理
      promises.push(updateOrderInFile(descriptionJsonPath));
    }

    // 使用 Promise.all 并发处理所有文件
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error);
  }
}
