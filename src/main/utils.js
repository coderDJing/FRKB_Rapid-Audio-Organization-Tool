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
    } else if (type == 'plus') {
      jsonObj.order++;
    }
    await fs.outputJson(filePath, jsonObj);
  } catch (error) {
    console.error(`Error updating ${filePath}:`, error);
  }
}

// 异步函数，用于遍历目录并处理 description.json 文件中的order小于参数orderNum时+1 direction='before'||'after' operation='plus'||'minus'
export const updateTargetDirSubdirOrder = async (dirPath, orderNum, direction, operation) => {
  try {
    const subdirs = await fs.readdir(dirPath, { withFileTypes: true });
    const dirs = subdirs.filter(dirent => dirent.isDirectory());
    const promises = [];
    for (const dirent of dirs) {
      const subdirPath = join(dirPath, dirent.name);
      const descriptionJsonPath = join(subdirPath, 'description.json');
      let description = await fs.readJSON(descriptionJsonPath)
      if (direction == 'before') {
        if (description.order < orderNum) {
          promises.push(updateOrderInFile(descriptionJsonPath, operation));
        }
      } else if (direction == 'after') {
        if (description.order > orderNum) {
          promises.push(updateOrderInFile(descriptionJsonPath, operation));
        }
      }
    }
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error);
  }
}
