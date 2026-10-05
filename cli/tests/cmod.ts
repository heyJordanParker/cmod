import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readSteps, scriptsSha256 } from 'cmod-sdk/src/records.js'
import { listFiles, readText } from '../src/files.js'

const main = join(import.meta.dir, '..', 'src', 'main.ts')
const homes: string[] = []

export const cmodFromSource = `#!/bin/sh
exec "${process.execPath}" "${main}" "$@"
`

export const cmodPluginListed = [{ id: 'cmod@cmod', version: '0.1.0', scope: 'user', enabled: true, installPath: '/cmod' }]

export const claudeAnswering = (listed: unknown[], session = 'exit 1') => `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json") echo '${JSON.stringify(listed)}' ;;
  "plugin marketplace list --json") echo '[]' ;;
  "plugin marketplace add heyJordanParker/cmod") ;;
  "plugin install cmod@"*" --json") echo '{"outcome":"ok","message":"Installed '"$3"'"}' ;;
  "--plugin-dir "*)
${session}
    ;;
  *) exit 1 ;;
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
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: '',
      XDG_CONFIG_HOME: '',
      CLAUDE_CONFIG_DIR: '',
      PATH: `${join(home, 'bin')}:${process.env['PATH']}`,
      CMOD_SDK: `file:${join(import.meta.dir, '..', '..', 'sdk')}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, stdout, stderr }
}

export async function hashOf(root: string): Promise<string> {
  const steps = readSteps(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))) ?? {}
  return scriptsSha256(steps, { read: (path) => readText(join(root, path)), list: (folder) => listFiles(join(root, folder)) })
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), text)
    if (path.endsWith('.sh') || path.startsWith('bin/')) await chmod(join(root, path), 0o755)
  }
}
