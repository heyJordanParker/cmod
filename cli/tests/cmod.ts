import { existsSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readSteps, scriptsSha256 } from '@cmodjs/core/src/records.js'
import { ifMissing, listFiles, readText } from '../src/files.js'

const main = join(import.meta.dir, '..', 'src', 'main.ts')
const homes: string[] = []
const temporaryRoot = await realpath(tmpdir())

export const cmodFromSource = `#!/bin/sh
exec "${process.execPath}" "${main}" "$@"
`

export const cmodPluginListed = [{ id: 'cmod@cmod', version: '0.1.0', scope: 'user', enabled: true, installPath: '/cmod' }]

const marketplaces = `const [action, value, flag, scope] = process.argv.slice(1)
const fs = require("node:fs")
const path = require("node:path")
const config = process.env.CLAUDE_CONFIG_DIR || process.env.HOME + "/.claude"
const knownFile = config + "/plugins/known_marketplaces.json"
const userFile = config + "/settings.json"
const localFile = path.join(process.cwd(), ".claude", "settings.local.json")
const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {})
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n")
}
const known = read(knownFile)
if (action === "list") {
  console.log(JSON.stringify(Object.entries(known).map(([name, entry]) => ({ name, source: entry.source.source, path: entry.source.path, repo: entry.source.repo, installLocation: entry.installLocation }))))
  process.exit(0)
}
if (action === "add") {
  const isFolder = value.startsWith("/")
  const name = isFolder ? JSON.parse(fs.readFileSync(value + "/.claude-plugin/marketplace.json", "utf8")).name : value.split("/").pop()
  const source = isFolder ? { source: "directory", path: value } : { source: "github", repo: value }
  const file = flag === "--scope" && scope === "local" ? localFile : userFile
  const settings = read(file)
  known[name] = { source, installLocation: isFolder ? value : config + "/plugins/marketplaces/" + name }
  write(file, { ...settings, extraKnownMarketplaces: { ...settings.extraKnownMarketplaces, [name]: { source } } })
} else {
  delete known[value]
  for (const file of [userFile, localFile]) {
    if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes(JSON.stringify(value))) continue
    const settings = read(file)
    delete settings.extraKnownMarketplaces[value]
    write(file, settings)
  }
}
write(knownFile, known)`

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
  "plugin marketplace list --json") "${process.execPath}" -e '${marketplaces}' list ;;
  "plugin marketplace add "*) "${process.execPath}" -e '${marketplaces}' add "$4" "$5" "$6" ;;
  "plugin marketplace remove "*"-linked") "${process.execPath}" -e '${marketplaces}' remove "$4" ;;
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
  for (const home of homes.splice(0)) await removeTemporary(home)
}

async function removeTemporary(folder: string): Promise<void> {
  if (!folder.startsWith(join(temporaryRoot, 'cmod-'))) throw new Error(`${folder} is not a folder the cmod program's tests made in ${temporaryRoot}, so they leave it.`)
  await rm(folder, { recursive: true, force: true })
}

export async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(temporaryRoot, 'cmod-test-'))
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

export const fourStepInstall = `#!/bin/sh
echo "progress 1 4 Checking Homebrew"
echo "progress 2 4 Installing trash"
echo "progress 3 4 Adding the zsh alias"
echo "progress 4 4 Finishing"
echo "ran in $CMOD_PLUGIN_ROOT at $CMOD_VERSION" >> "$CMOD_DATA/runs"
`

export async function createMod(home: string, install = fourStepInstall): Promise<string> {
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
    'setup/install.sh': install,
    'setup/uninstall.sh': '#!/bin/sh\necho "uninstalled from $CMOD_PLUGIN_ROOT" >> "$HOME/uninstalls"\n',
  })
  return root
}

export const platform = `${process.platform}-${process.arch}`
export const release = '/owner/hello-mod/releases/download/v0.2.0'
export const helloBuild = { [`hello-${platform}`]: '#!/bin/sh\necho "hello 0.2.0"\n' }

export function sha256Sums(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, text]) => `${new Bun.CryptoHasher('sha256').update(text).digest('hex')}  ${name}\n`)
    .join('')
}

export function serveRelease(files: Record<string, string>, delayMs = 0) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const { pathname } = new URL(request.url)
      const file = pathname.startsWith(`${release}/`) ? files[pathname.slice(release.length + 1)] : undefined
      await Bun.sleep(delayMs)
      return file === undefined ? new Response('Not Found', { status: 404 }) : new Response(file)
    },
  })
}

export async function createProgramMod(home: string, repository: string): Promise<string> {
  const root = join(home, 'hello-mod')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0', repository }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho "progress 1 2 Adding the alias"\necho "progress 2 2 Finishing"\necho ran >> "$CMOD_DATA/runs"\n',
  })
  return root
}

export async function waitFor(path: string): Promise<void> {
  while (!existsSync(path)) await Bun.sleep(10)
}

export const lockNotice = 'Waiting for ~/.local/share/cmod/records/demo.json.lock'

export const isGone = (path: string) => lstat(path).then(() => false, ifMissing(true))

export async function goneProcessId(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  return child.pid
}

export async function startOf(processId: number): Promise<string> {
  const ps = Bun.spawn(['/bin/ps', '-o', 'lstart=', '-p', String(processId)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdout: 'pipe' })
  return (await new Response(ps.stdout).text()).trim()
}
