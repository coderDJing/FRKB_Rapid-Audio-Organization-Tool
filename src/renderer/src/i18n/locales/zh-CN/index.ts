const modules = import.meta.glob<{ default: Record<string, unknown> }>('./*.json', {
  eager: true
})

const zhCN = Object.values(modules).reduce<Record<string, unknown>>((acc, module) => {
  return {
    ...acc,
    ...module.default
  }
}, {})

export default zhCN
