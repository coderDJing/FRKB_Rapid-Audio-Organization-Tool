import { join } from 'path'
const fs = require('fs-extra')
const path = require('path');

export const deleteFolderRecursive = async (folderPath) => {
  // 检查文件夹是否存在
  if (!fs.existsSync(folderPath)) {
    console.log(`Folder ${folderPath} does not exist`);
    return;
  }

  // 读取文件夹内容
  const files = await fs.promises.readdir(folderPath, { withFileTypes: true });

  // 遍历文件夹内容
  for (const file of files) {
    const filePath = path.join(folderPath, file.name);

    // 如果是文件，则删除
    if (file.isFile()) {
      await fs.promises.unlink(filePath);
    }
    // 如果是文件夹，则递归删除
    else if (file.isDirectory()) {
      await deleteFolderRecursive(filePath);
    }
  }

  // 删除空文件夹
  await fs.promises.rmdir(folderPath);
}

export const readJsonFile = async (filePath) => {
  try {
    const fileContent = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(fileContent);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`文件 ${filePath} 不存在`);
    } else {
      console.error(`read file ${filePath} occur error: ${err.message}`);
    }
    return null;
  }
}

async function getdirsDescriptionJson(dirPath, dirs) {
  const jsons = await Promise.all(dirs.map(async (dir) => {
    const filePath = path.join(dirPath, dir.name, 'description.json');
    const json = await readJsonFile(filePath);
    const subDirPath = path.join(dirPath, dir.name);
    const subEntries = await fs.promises.readdir(subDirPath, { withFileTypes: true });
    const subDirs = subEntries.filter(entry => entry.isDirectory());
    const subJsons = await getdirsDescriptionJson(subDirPath, subDirs);
    json.children = subJsons;
    return json;
  }));

  return jsons.sort((a, b) => a.order - b.order);
}

//获取整个库的树结构
export async function getLibrary() {
  const dirPath = path.join(__dirname, 'library');
  const rootDescriptionJson = await readJsonFile(path.join(dirPath, 'description.json'));
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory());
  const dirsDescriptionJson = await getdirsDescriptionJson(dirPath, dirs);
  rootDescriptionJson.children = dirsDescriptionJson;
  return rootDescriptionJson;
}


// 异步函数，用于读取和更新 description.json 文件中的 order 属性
async function updateOrderInFile(filePath, type) {
  try {
    // 读取文件内容
    const content = await fs.promises.readFile(filePath, 'utf8');
    // 解析 JSON
    const jsonObj = JSON.parse(content);

    // 确保 jsonObj 有一个 order 属性，并递增它
    if (jsonObj.order !== undefined) {
      if (type == 'minus') {
        jsonObj.order--;
      } else {
        jsonObj.order++;
      }

    } else {
      // jsonObj.order = 1; // 如果没有 order 属性，则设置为 1
    }

    // 将修改后的对象转回 JSON 字符串
    const newContent = JSON.stringify(jsonObj, null, 2);

    // 写入文件
    await fs.promises.writeFile(filePath, newContent, 'utf8');
  } catch (error) {
    console.error(`Error updating ${filePath}:`, error);
  }
}
// 异步函数，用于遍历目录并处理 description.json 文件中的order大于参数orderNum时-1
export const updateTargetDirSubdirOrderAfterNumMinus = async (dirPath, orderNum) => {
  try {
    // 读取目录内容
    const subdirs = await fs.promises.readdir(dirPath, { withFileTypes: true });

    // 过滤出子文件夹
    const dirs = subdirs.filter(dirent => dirent.isDirectory());

    // 初始化一个用于存储 Promise 的数组
    const promises = [];

    // 遍历每个子文件夹
    for (const dirent of dirs) {
      const subdirPath = path.join(dirPath, dirent.name);
      const descriptionJsonPath = path.join(subdirPath, 'description.json');
      let description = await readJsonFile(descriptionJsonPath)
      if (description.order > orderNum) {
        // 添加一个 Promise 到数组中以并发处理
        promises.push(fs.promises.access(descriptionJsonPath, fs.promises.constants.F_OK)
          .then(() => updateOrderInFile(descriptionJsonPath, 'minus'))
          .catch(err => {
            if (err.code !== 'ENOENT') {
              console.error(`Error accessing ${descriptionJsonPath}:`, err);
            }
          }));
      }
    }
    // 使用 Promise.all 并发处理所有文件
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error);
  }
}

// 异步函数，用于遍历目录并处理 description.json 文件中的order++
export const updateTargetDirSubdirOrder = async (dirPath) => {
  try {
    // 读取目录内容
    const subdirs = await fs.promises.readdir(dirPath, { withFileTypes: true });

    // 过滤出子文件夹
    const dirs = subdirs.filter(dirent => dirent.isDirectory());

    // 初始化一个用于存储 Promise 的数组
    const promises = [];

    // 遍历每个子文件夹
    for (const dirent of dirs) {
      const subdirPath = path.join(dirPath, dirent.name);
      const descriptionJsonPath = path.join(subdirPath, 'description.json');

      // 添加一个 Promise 到数组中以并发处理
      promises.push(fs.promises.access(descriptionJsonPath, fs.promises.constants.F_OK)
        .then(() => updateOrderInFile(descriptionJsonPath))
        .catch(err => {
          if (err.code !== 'ENOENT') {
            console.error(`Error accessing ${descriptionJsonPath}:`, err);
          }
        }));
    }

    // 使用 Promise.all 并发处理所有文件
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error);
  }
}
