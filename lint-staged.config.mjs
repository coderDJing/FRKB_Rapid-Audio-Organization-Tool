// lint-staged 配置。
//
// 使用函数式配置对匹配文件分批，避免在 Windows 上一次性把上百个文件路径
// 拼进单条 `prettier --write` 命令时触发「命令行太长」(ENAMETOOLONG)。
// 每批最多 40 个文件，分多条命令串行执行。

const BATCH_SIZE = 40

/** 将文件列表按 BATCH_SIZE 分批，生成多条 prettier 命令。 */
const buildPrettierCommands = (files) => {
  const commands = []
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE)
    commands.push(`prettier --write ${batch.map((f) => JSON.stringify(f)).join(' ')}`)
  }
  return commands
}

export default {
  '*.{js,jsx,ts,tsx,vue,css,scss,less,json}': buildPrettierCommands
}
