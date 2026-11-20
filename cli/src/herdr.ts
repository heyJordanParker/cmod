import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isObject } from '@cmodjs/core/src/records.js'
import mainJs from '../../herdr/cmod/main.js' with { type: 'text' }
import modJson from '../../herdr/cmod/mod.json' with { type: 'json' }
import { home, ifMissing, readJson, readText, writeAtomically } from './files.js'
import { storePath, takeLock } from './store.js'

const carried: Readonly<Record<string, string>> = { 'main.js': mainJs, 'mod.json': `${JSON.stringify(modJson)}\n` }

const writtenWhileRunning: readonly string[] = ['gpui-kit.d.ts', 'jsconfig.json', '.drawn']

type Placed = Record<string, Record<string, string>>

function herdrHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env['HERDR_APP_HOME'] || join(env['XDG_CONFIG_HOME'] || join(home(), '.config'), 'herdr-app')
}

export async function placeHerdrMod(): Promise<void> {
  const appHome = herdrHome()
  if (!existsSync(appHome)) return
  const folder = join(appHome, 'mods', 'cmod')
  await withPlaced(async (placed) => {
    const mine = placed[folder] ?? {}
    const found = Object.fromEntries(await Promise.all(Object.keys({ ...carried, ...mine }).map(async (name) => [name, await readText(join(folder, name))] as const)))
    const others = Object.keys(carried).filter((name) => found[name] !== undefined && found[name] !== carried[name] && hashOf(found[name]) !== mine[name])
    if (others.length > 0) throw new Error(`${others.map((name) => join(folder, name)).join(' and ')} ${others.length === 1 ? 'is' : 'are'} not the cmod Herdr mod cmod placed, so cmod leaves ${others.length === 1 ? 'it' : 'them'} and places no Herdr mod. Move ${folder} away, then start cmod serve again.`)
    for (const [name, text] of Object.entries(carried)) {
      if (found[name] !== text) await writeAtomically(join(folder, name), text)
      mine[name] = hashOf(text)
    }
    for (const name of Object.keys(mine).filter((each) => !Object.hasOwn(carried, each))) {
      if (found[name] !== undefined && hashOf(found[name]) === mine[name]) await rm(join(folder, name))
      delete mine[name]
    }
    placed[folder] = mine
  })
}

export async function removeHerdrMod(): Promise<void> {
  await withPlaced(async (placed) => {
    for (const [folder, files] of Object.entries(placed)) {
      for (const [name, hash] of Object.entries(files)) {
        const found = await readText(join(folder, name))
        if (found !== undefined && hashOf(found) === hash) await rm(join(folder, name))
      }
      const left = await readdir(folder).catch(ifMissing([]))
      if (left.every((name) => writtenWhileRunning.includes(name))) await rm(folder, { recursive: true, force: true })
      delete placed[folder]
    }
  })
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function withPlaced(change: (placed: Placed) => Promise<void>): Promise<void> {
  const lock = await takeLock(storePath('herdr.lock'))
  try {
    const parsed = await readJson(storePath('herdr.json'))
    const placed: Placed = isObject(parsed) ? (parsed as Placed) : {}
    const before = JSON.stringify(placed)
    try {
      await change(placed)
    } finally {
      if (JSON.stringify(placed) !== before) await writeAtomically(storePath('herdr.json'), `${JSON.stringify(placed)}\n`)
    }
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}
