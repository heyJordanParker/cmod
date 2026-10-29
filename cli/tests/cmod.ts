import { writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readSteps, scriptsSha256 } from '@cmodjs/core/src/records.js'
import { listFiles, readText } from '../src/files.js'

const main = join(import.meta.dir, '..', 'src', 'main.ts')
const homes: string[] = []

export const cmodFromSource = `#!/bin/sh
exec "${process.execPath}" "${main}" "$@"
`

export const cmodPluginListed = [{ id: 'cmod@cmod', version: '0.1.0', scope: 'user', enabled: true, installPath: '/cmod' }]

const knownMarketplaces = `const [action, value] = process.argv.slice(1)
const fs = require("node:fs")
const file = (process.env.CLAUDE_CONFIG_DIR || process.env.HOME + "/.claude") + "/plugins/known_marketplaces.json"
const known = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
if (action === "add") known[JSON.parse(fs.readFileSync(value + "/.claude-plugin/marketplace.json", "utf8")).name] = { source: { source: "directory", path: value }, installLocation: value }
else delete known[value]
fs.mkdirSync(require("node:path").dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(known))`

const validates = `const fs = require("node:fs")
const path = require("node:path")
const manifest = process.argv[1]
const root = path.dirname(path.dirname(manifest))
const named = manifest.endsWith("plugin.json") ? Object.entries(JSON.parse(fs.readFileSync(manifest, "utf8"))) : []
const missing = named.filter(([, value]) => typeof value === "string" && value.startsWith("./") && !fs.existsSync(path.join(root, value)))
console.log("Validating plugin manifest: " + manifest + "\\n")
if (missing.length === 0) console.log("✔ Validation passed")
else console.log("✘ Found " + missing.length + " error" + (missing.length === 1 ? "" : "s") + ":\\n\\n" + missing.map(([key, value]) => "  ❯ " + key + ": Path not found: " + value + ". The runtime loader will report this as a load failure.").join("\\n") + "\\n\\n✘ Validation failed")
process.exit(missing.length === 0 ? 0 : 1)`

export const claudeAnswering = (listed: unknown[], session = 'exit 1', updated = listed) => `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json") if grep -q '^plugin update ' "$HOME/claude-calls"; then echo '${JSON.stringify(updated)}'; else echo '${JSON.stringify(listed)}'; fi ;;
  "plugin update "*" --json") echo '{"outcome":"ok"}' ;;
  "plugin marketplace list --json") echo '[]' ;;
  "plugin marketplace add heyJordanParker/cmod") ;;
  "plugin marketplace add /"*) "${process.execPath}" -e '${knownMarketplaces}' add "$4" ;;
  "plugin marketplace remove "*"-linked") "${process.execPath}" -e '${knownMarketplaces}' remove "$4" ;;
  "plugin marketplace update "*"-linked") ;;
  "plugin install cmod@"*" --json"|"plugin install "*"-linked --json"|"plugin uninstall "*"-linked --json") echo '{"outcome":"ok","message":"Installed '"$3"'"}' ;;
  "plugin validate "*" --strict") "${process.execPath}" -e '${validates}' "$3" ;;
  "plugin "*) exit 1 ;;
  *)
    echo "$*" >> "$HOME/claude-sessions"
${session}
    ;;
esac
`

export async function deleteTemporaryHomes(): Promise<void> {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
}

export async function temporaryHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cmod-test-')))
  homes.push(home)
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed) })
  return home
}

export async function cmod(home: string, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return startCmod(home, ...args).done
}

export function startCmod(home: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], { cwd: home, env: environment(home), stdout: 'pipe', stderr: 'pipe' })
  return { child, ...watchOutput(child) }
}

export async function cmodOnPath(home: string, path: string, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return cmodWith(home, { PATH: path }, ...args)
}

export async function cmodWith(home: string, env: Record<string, string>, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, main, ...args], { cwd: home, env: { ...environment(home), ...env }, stdout: 'pipe', stderr: 'pipe' })
  return watchOutput(child).done
}

export async function cmodInTerminal(home: string, ...args: string[]): Promise<{ exitCode: number; output: string }> {
  const { exitCode, stdout } = await startCmodInTerminal(home, ...args).done
  return { exitCode, output: stdout }
}

export function startCmodInTerminal(home: string, ...args: string[]) {
  const child = Bun.spawn(['script', '-q', '/dev/null', 'sh', '-c', 'trap : INT; "$0" "$@"; exit $?', process.execPath, main, ...args], {
    cwd: home,
    env: environment(home),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  writeFileSync(join(home, 'terminal-pid'), `${child.pid}\n`)
  return { child, ...watchOutput(child) }
}

function watchOutput(child: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exitCode: number | null; exited: Promise<number> }) {
  const output = { stdout: '', stderr: '' }
  let isDone = false
  const read = async (name: 'stdout' | 'stderr') => {
    const decoder = new TextDecoder()
    for await (const bytes of child[name]) output[name] += decoder.decode(bytes, { stream: true })
  }
  const done = Promise.all([read('stdout'), read('stderr'), child.exited]).then(([, , exitCode]) => {
    isDone = true
    return { exitCode, ...output }
  })
  async function waitForOutput(text: string): Promise<void> {
    while (!output.stdout.includes(text) && !output.stderr.includes(text)) {
      if (isDone) throw new Error(`cmod exited ${child.exitCode} before it printed "${text}". It printed:\n${output.stdout}${output.stderr}`)
      await Bun.sleep(10)
    }
  }
  return { done, waitForOutput }
}

export function environment(home: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: '',
    XDG_CONFIG_HOME: '',
    CLAUDE_CONFIG_DIR: '',
    CLAUDE_CODE_EXECPATH: '',
    PATH: `${join(home, 'bin')}:${process.env['PATH']}`,
    CMOD_CORE: `file:${join(import.meta.dir, '..', '..', 'core')}`,
  }
}

export async function hashOf(root: string): Promise<string> {
  const steps = readSteps(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))) ?? {}
  return scriptsSha256(steps, { read: (path) => readText(join(root, path)), list: (folder) => listFiles(join(root, folder)) })
}

export async function writeLinked(home: string, checkout: string): Promise<void> {
  const parent = dirname(checkout)
  const marketplace = `${basename(parent)}-linked`
  const { name } = JSON.parse(await readFile(join(checkout, '.claude-plugin/plugin.json'), 'utf8')) as { name: string }
  await writeFiles(parent, { '.claude-plugin/marketplace.json': JSON.stringify({ name: marketplace, owner: { name: 'cmod link' }, plugins: [{ name, source: `./${basename(checkout)}`, description: name }] }) })
  await writeFiles(home, {
    '.claude/plugins/known_marketplaces.json': JSON.stringify({ [marketplace]: { source: { source: 'directory', path: parent }, installLocation: parent } }),
    '.local/share/cmod/links.json': JSON.stringify({ marketplaces: { [marketplace]: parent }, turnedOff: { [name]: [] } }),
  })
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), text)
    if (path.endsWith('.sh') || path.startsWith('bin/')) await chmod(join(root, path), 0o755)
  }
}
