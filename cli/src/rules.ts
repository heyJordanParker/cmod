import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isObject, readRecord, storeFolder } from '@cmodjs/core/src/records.js'
import { parse } from 'jsonc-parser'
import { ifMissing, readJson, readLink, readText, writeAtomically } from './files.js'
import { configRoot, excludeRules, includeRules, isLinked, settingsPath } from './settings.js'
import { approvals, recordNames, storePath, takeLock } from './store.js'

export type Rule = { readonly name: string; readonly isGlobal: boolean; readonly text: string }

export type LinkedRules = { readonly mod: string; readonly folder: string; readonly rules: readonly Rule[] }

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function rulesFolderOf(root: string): string {
  return join(root, 'rules')
}

export async function readRules(folder: string): Promise<Rule[]> {
  if (!existsSync(folder)) return []
  const names = (await readdir(folder)).filter((name) => name.endsWith('.md')).sort()
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(folder, name), 'utf8')
      const head = frontmatter.exec(text)
      return { name: name.slice(0, -'.md'.length), isGlobal: !/^paths\s*:/m.test(head?.[1] ?? ''), text: text.slice(head?.[0].length ?? 0).trim() }
    }),
  )
}

export type SyncedRules = { readonly linked: readonly LinkedRules[]; readonly placed: readonly string[]; readonly removed: readonly string[]; readonly watched: readonly string[] }

export async function syncRules(project: string, pluginDirs: readonly string[] = []): Promise<SyncedRules> {
  const store = storeFolder(process.env)
  const userRules = join(configRoot(), 'rules')
  const projectRules = join(project, '.claude', 'rules')
  const projectLocal = join(project, '.claude', 'settings.local.json')
  const [user, here] = await Promise.all([settingsOf([settingsPath()]), settingsOf([join(project, '.claude', 'settings.json'), projectLocal])])
  const isExcluded = (path: string) => [...user.excluded, ...here.excluded].some((glob) => glob.match(path))
  const names = await recordNames()
  const linked: LinkedRules[] = []
  const placed: string[] = []
  const removed: string[] = []
  const watched = new Set([settingsPath(), join(project, '.claude', 'settings.json'), projectLocal, userRules, projectRules, storePath('records'), storePath('consent.json'), storePath('rules.json')])
  if (names.length === 0 && !existsSync(storePath('rules.json'))) return { linked, placed, removed, watched: [...watched] }
  await withPlaced(async (recorded) => {
    const drop = async (entry: Placed) => {
      if (await undo(entry)) removed.push(entry.mod)
      recorded.splice(recorded.indexOf(entry), 1)
    }
    for (const mod of names) {
      watched.add(storePath('records', `${mod}.json`))
      const record = await readRecord(readText, store, mod)
      if (record === undefined) continue
      const source = rulesFolderOf(record.root)
      watched.add(source)
      const isWanted = existsSync(source) && (await approvals(mod)).includes('prompt')
      const isEverywhere = user.enabled.get(mod) === true || pluginDirs.includes(record.root) || (await isLinked(record.root))
      const isHere = here.enabled.get(mod) ?? isEverywhere
      const link = !isWanted ? undefined : isEverywhere ? join(userRules, mod) : here.enabled.get(mod) === true ? join(projectRules, mod) : undefined
      const exclude = link !== undefined && isEverywhere && !isHere ? `${link}/**` : undefined
      const isMine = (entry: Placed) => entry.mod === mod && (!isWanted || ('link' in entry ? [join(userRules, mod), join(projectRules, mod)].includes(entry.link) : entry.settings === projectLocal))
      for (const entry of recorded.filter(isMine)) {
        const isKept = 'link' in entry ? entry.link === link && entry.source === source && (await readLink(entry.link)) === source : entry.pattern === exclude
        if (!isKept) await drop(entry)
      }
      if (link !== undefined && !recorded.some((each) => 'link' in each && each.link === link)) {
        await placeLink(link, source)
        recorded.push({ mod, link, source })
        placed.push(mod)
      }
      if (exclude !== undefined && !recorded.some((each) => 'pattern' in each && each.settings === projectLocal && each.pattern === exclude)) {
        if (await excludeRules(projectLocal, exclude)) {
          recorded.push({ mod, settings: projectLocal, pattern: exclude })
          removed.push(mod)
        }
      }
      if (link === undefined || !isHere) continue
      const rules = await readRules(source)
      for (const rule of rules) watched.add(join(source, `${rule.name}.md`))
      linked.push({ mod, folder: link, rules: rules.filter((rule) => !isExcluded(join(link, `${rule.name}.md`)) && !isExcluded(join(source, `${rule.name}.md`))) })
    }
    for (const entry of recorded.filter((each) => !names.includes(each.mod))) await drop(entry)
  })
  return { linked, placed, removed: [...new Set(removed)].filter((mod) => !placed.includes(mod) && !linked.some((each) => each.mod === mod)), watched: [...watched] }
}

export async function unlinkRules(mod: string): Promise<void> {
  await withPlaced(async (recorded) => {
    for (const entry of recorded.filter((each) => each.mod === mod)) {
      await undo(entry)
      recorded.splice(recorded.indexOf(entry), 1)
    }
  })
}

type Placed = { readonly mod: string; readonly link: string; readonly source: string } | { readonly mod: string; readonly settings: string; readonly pattern: string }

async function withPlaced(change: (recorded: Placed[]) => Promise<void>): Promise<void> {
  const lock = await takeLock(storePath('rules.lock'))
  try {
    const parsed = await readJson(storePath('rules.json'))
    const recorded = Array.isArray(parsed) ? (parsed as Placed[]) : []
    const before = JSON.stringify(recorded)
    try {
      await change(recorded)
    } finally {
      if (JSON.stringify(recorded) !== before) await writeAtomically(storePath('rules.json'), `${JSON.stringify(recorded)}\n`)
    }
  } finally {
    await lock[Symbol.asyncDispose]()
  }
}

async function placeLink(link: string, source: string): Promise<void> {
  const found = await lstat(link).catch(ifMissing(undefined))
  if (found?.isSymbolicLink() === true) throw new Error(`${link} links to ${await readlink(link)}, which cmod did not link, so cmod leaves it. Move it away, then run the command again.`)
  if (found !== undefined) throw new Error(`${link} is a folder of its own, so cmod cannot link the mod's rules there. Move it away, then run the command again.`)
  await mkdir(dirname(link), { recursive: true })
  await symlink(source, link)
}

async function undo(entry: Placed): Promise<boolean> {
  if ('settings' in entry) {
    await includeRules(entry.settings, entry.pattern)
    return false
  }
  if ((await readLink(entry.link)) !== entry.source) return false
  await rm(entry.link)
  return true
}

async function settingsOf(files: readonly string[]): Promise<{ readonly enabled: Map<string, boolean>; readonly excluded: readonly Bun.Glob[] }> {
  const enabled = new Map<string, boolean>()
  const excluded: Bun.Glob[] = []
  for (const file of files) {
    const text = await readText(file)
    const parsed: unknown = text === undefined ? undefined : parse(text)
    if (!isObject(parsed)) continue
    for (const [id, value] of Object.entries(isObject(parsed['enabledPlugins']) ? parsed['enabledPlugins'] : {})) enabled.set(id.replace(/@[^@]*$/, ''), value === true)
    const patterns: unknown = parsed['claudeMdExcludes']
    if (Array.isArray(patterns)) excluded.push(...patterns.filter((pattern) => typeof pattern === 'string').map((pattern) => new Bun.Glob(pattern)))
  }
  return { enabled, excluded }
}
