import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { isPathInside, normalizeFsPath, pathsEqual } from './paths'

describe('libraryRelocate paths', () => {
  it('把同一路径的不同写法视为相等', () => {
    const left = path.join('D:', 'Music', 'Lib')
    const right = path.join('D:', 'Music', 'Lib', '.')
    expect(pathsEqual(left, right)).toBe(true)
    expect(normalizeFsPath(left)).toBe(normalizeFsPath(path.resolve(right)))
  })

  it('能判断子目录关系', () => {
    const parent = path.resolve('/tmp/frkb-lib')
    const child = path.join(parent, 'library', 'FilterLibrary')
    expect(isPathInside(child, parent)).toBe(true)
    expect(isPathInside(parent, child)).toBe(false)
    expect(isPathInside(parent, parent)).toBe(false)
  })
})
