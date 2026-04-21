const modules = import.meta.glob<{ default: Record<string, unknown> }>('./*.json', {
  eager: true
})

const enUS = Object.values(modules).reduce<Record<string, unknown>>((acc, module) => {
  return {
    ...acc,
    ...module.default
  }
}, {})

export default enUS
