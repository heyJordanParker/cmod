import { picomatch } from '../vendor.js'

export function matchesGlob(path: string, pattern: string): boolean {
  return picomatch.isMatch(path, pattern, { dot: true })
}
