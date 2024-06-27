import { join } from 'path'
const fs = require('fs')

export const readJsonFile = async (filePath) => {
  try {
    const fileContent = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(fileContent);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`文件 ${filePath} 不存在`);
    } else {
      console.error(`读取文件 ${filePath} 时出错: ${err.message}`);
    }
    return null;
  }
}
export const readSortedDescriptionFiles = async (directoryPath) => {
  try {
    // 读取目录中的文件夹
    const dirs = await fs.promises.readdir(directoryPath, { withFileTypes: true }).then(dirents => dirents.filter(dirent => dirent.isDirectory()));
    // 存储所有description.json文件的内容
    const descriptions = [];

    // 遍历每个文件夹
    for (const dir of dirs) {
      const dirPath = join(directoryPath, dir.name);
      const filePath = join(dirPath, 'description.json');

      // 读取文件内容
      const fileData = await readJsonFile(filePath);
      if (fileData && fileData.order !== undefined) {
        // 如果文件存在且包含order属性，则添加到数组中
        descriptions.push({ path: filePath, data: fileData });
      }
    }

    // 按order属性排序
    descriptions.sort((a, b) => a.data.order - b.data.order);
    // 只返回文件数据（如果需要路径，可以返回整个对象）
    return descriptions.map(desc => desc.data);
  } catch (err) {
    console.error(`读取目录 ${directoryPath} 时出错: ${err.message}`);
    return []; // 或抛出错误，取决于你的错误处理策略
  }
}
