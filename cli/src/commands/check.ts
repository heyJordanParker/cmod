import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { isObject, scriptsSha256 } from '@cmodjs/core/src/records.js'
import { version as cmodVersion } from '../../package.json'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { listPlugins } from '../claude.js'
import { listFiles, readJson, readText, writeAtomically } from '../files.js'
import { preparePackages, readPlugin, type Plugin } from '../plugin.js'
import { bunArgv, capture, run as runCommand, spawn } from '../process.js'
import { startProgress } from '../progress.js'
import { bundledHooks } from './publish.js'
import { linkedFolders } from '../settings.js'
import { storePath } from '../store.js'

export const summary = 'Run every check on a mod, each failure with its fix.'

export const help = `Usage: cmod check [path]

${summary}

Runs every check this machine can run on the mod at path (default: the current
folder): installs its packages, checks its layout and that each step runs a
script, bundles its hooks module as cmod publish does, validates it with Claude
Code, type-checks it with tsconfig.json and, when it exists, tests/tsconfig.json,
lints it, runs its tests with bun test and with claude plugin test, and checks
its name. Each failure names its fix.`

type Result = { status: 'pass' | 'fail' | 'skip'; text: string; fix?: string }

type Check = { heading: string; run(plugin: Plugin): Promise<Result> }

const typescript = { name: 'typescript', version: '7.0.2', program: 'tsc' }
const oxlint = { name: 'oxlint', version: '1.86.0', program: 'oxlint' }
const skippedFolders = new Set(['node_modules', '.git', 'target', '.target'])
const componentNames = ['skills', 'commands', 'agents', 'hooks', 'monitors', 'output-styles', 'themes', 'workflows', 'bin', 'settings.json', '.mcp.json', '.lsp.json', 'SKILL.md']

const checks: Check[] = [
  { heading: 'Installing packages', run: checkPackages },
  { heading: 'Checking the layout', run: checkLayout },
  { heading: 'Checking the steps', run: checkSteps },
  { heading: 'Checking imports', run: checkImports },
  { heading: 'Looking for prebuilt binaries', run: checkBinaries },
  { heading: 'Bundling the hooks', run: checkBundle },
  { heading: 'Validating with Claude Code', run: checkValidate },
  { heading: 'Type-checking', run: checkTypes },
  { heading: 'Linting', run: checkLint },
  { heading: 'Running tests', run: checkTests },
  { heading: "Running tests in Claude Code's test kit", run: checkPluginTests },
  { heading: 'Checking the plugin name', run: checkNameConflict },
]

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  if (positionals.length > 1) throw new Error(`cmod check takes at most one path.\n\n${help}`)
  const plugin = await readPlugin(positionals[0] ?? '.')
  const progress = startProgress()
  const counts = { pass: 0, fail: 0, skip: 0 }
  for (const check of checks) {
    progress.step(check.heading)
    const result = await check.run(plugin)
    counts[result.status] += 1
    if (result.status === 'pass') progress.succeed(result.text)
    if (result.status === 'skip') progress.skip(result.text)
    if (result.status === 'fail') progress.fail(`${result.text}\n    fix: ${result.fix}`)
  }
  process.stdout.write(`\n${plugin.name}: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped\n`)
  return counts.fail > 0 ? 1 : 0
}

async function checkPackages(plugin: Plugin): Promise<Result> {
  try {
    if (!(await preparePackages(plugin))) return { status: 'skip', text: 'No package.json, so no packages to install' }
    return { status: 'pass', text: 'Packages installed from package.json' }
  } catch (error) {
    return { status: 'fail', text: `Installing packages failed: ${messageOf(error)}`, fix: 'Fix the dependencies in package.json, then run cmod check again.' }
  }
}

async function checkLayout(plugin: Plugin): Promise<Result> {
  const problems: string[] = []
  if (existsSync(join(plugin.root, 'bin'))) problems.push('a root bin/ folder, which claude.ai and Cowork refuse: move the program into cli/, and cmod publish builds it')
  if (existsSync(join(plugin.root, 'target'))) problems.push('a root target/ folder: build a Rust program inside cli/, with target-dir = ".target" in cli/.cargo/config.toml')
  const dependencies = plugin.packageJson?.['devDependencies']
  if (isObject(dependencies) && Object.keys(dependencies).length > 0) problems.push(`devDependencies in package.json (${Object.keys(dependencies).join(', ')}): Claude Code installs them for every user, so move each into dependencies or drop it`)
  if (problems.length > 0) return { status: 'fail', text: `The layout has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}`, fix: problems.join('\n    fix: ') }
  const parts = (await readdir(plugin.root)).filter((entry) => componentNames.includes(entry))
  return { status: 'pass', text: `The layout fits a mod. Claude Code loads these root entries as parts of ${plugin.name}: ${parts.join(', ') || 'none'}` }
}

async function checkSteps(plugin: Plugin): Promise<Result> {
  if (plugin.steps.install === undefined && plugin.steps.uninstall === undefined) return { status: 'skip', text: 'No install or uninstall step, so no step to check' }
  try {
    await scriptsSha256(plugin.steps, { read: (path) => readText(join(plugin.root, path)), list: (folder) => listFiles(join(plugin.root, folder)) })
  } catch (error) {
    return { status: 'fail', text: 'The steps have a problem', fix: messageOf(error) }
  }
  return { status: 'pass', text: 'Each step runs a script in the mod, so consent covers its whole folder' }
}

async function checkImports(plugin: Plugin): Promise<Result> {
  const problems: string[] = []
  const cli = join(plugin.root, 'cli') + sep
  for (const file of await walk(plugin.root)) {
    if (!/\.(m?[jt]sx?|cts|cjs)$/.test(file)) continue
    const isSource = file.startsWith(join(plugin.root, 'src') + sep)
    for (const specifier of importsOf((await readText(file)) ?? '')) {
      if (specifier.startsWith('.') && resolve(dirname(file), specifier).startsWith(cli)) problems.push(`${relative(plugin.root, file)} imports ${specifier} from cli/, which the release leaves out: move the shared code into src/`)
      if (isSource && isBuiltin(specifier)) problems.push(`${relative(plugin.root, file)} imports ${specifier}: Claude Code runs mods with no Node or Bun, so use mod.fs, mod.process, or mod.http`)
    }
  }
  if (problems.length > 0) return { status: 'fail', text: `${problems.length} import${problems.length === 1 ? '' : 's'} a mod cannot use`, fix: problems.join('\n    fix: ') }
  return { status: 'pass', text: 'Imports reach only the mod, its packages, and claude-code' }
}

async function checkBinaries(plugin: Plugin): Promise<Result> {
  const binaries: string[] = []
  for (const file of await walk(plugin.root)) {
    const head = await Bun.file(file).slice(0, 4).bytes()
    const magic = [...head].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic)) binaries.push(relative(plugin.root, file))
  }
  if (binaries.length > 0) return { status: 'fail', text: `Prebuilt binaries in the mod: ${binaries.join(', ')}`, fix: 'Delete them. A program lives as source in cli/, and cmod publish builds it and attaches the builds to the release.' }
  return { status: 'pass', text: 'No prebuilt binaries outside cli/' }
}

async function checkBundle(plugin: Plugin): Promise<Result> {
  try {
    const bundled = await bundledHooks(plugin.root)
    if (bundled === undefined) return { status: 'skip', text: 'No hooks module in hooks/hooks.json, so nothing to bundle' }
    return { status: 'pass', text: `hooks/${bundled.module} bundles with its packages, as cmod publish bundles it` }
  } catch (error) {
    return { status: 'fail', text: messageOf(error), fix: 'Fix each error, then run cmod check again.' }
  }
}

async function checkValidate(plugin: Plugin): Promise<Result> {
  const targets = [join(plugin.root, '.claude-plugin', 'plugin.json')]
  if (existsSync(join(plugin.root, '.claude-plugin', 'marketplace.json'))) targets.push(join(plugin.root, '.claude-plugin', 'marketplace.json'))
  const failures: string[] = []
  for (const target of targets) {
    const result = await capture(['claude', 'plugin', 'validate', '--strict', target])
    if (result.exitCode !== 0) failures.push(`${relative(plugin.root, target)}:\n${(result.stdout + result.stderr).trim().split('\n').map((line) => `      ${line}`).join('\n')}`)
  }
  if (failures.length > 0) return { status: 'fail', text: `claude plugin validate --strict failed on ${failures.join('\n')}`, fix: 'Fix each error and warning it names, then run cmod check again.' }
  return { status: 'pass', text: `claude plugin validate --strict passed on ${targets.map((target) => relative(plugin.root, target)).join(' and ')}` }
}

async function checkTypes(plugin: Plugin): Promise<Result> {
  if (!existsSync(join(plugin.root, 'tsconfig.json'))) return { status: 'skip', text: 'Type check skipped: the mod has no tsconfig.json' }
  try {
    await writeClaudeTypes(plugin)
  } catch (error) {
    return { status: 'skip', text: `Type check skipped: ${messageOf(error)}` }
  }
  const tool = await fetchTool(typescript)
  if (typeof tool !== 'string') return tool
  const configs = ['tsconfig.json', 'tests/tsconfig.json'].filter((config) => existsSync(join(plugin.root, config)))
  const outputs: string[] = []
  for (const config of configs) {
    const result = await runTool(tool, ['-p', join(plugin.root, config), '--noEmit'], plugin.root)
    if (result.exitCode !== 0) outputs.push(`${config}:\n${result.output}`)
  }
  if (outputs.length > 0) return { status: 'fail', text: `tsc ${typescript.version} found type errors:\n${indent(outputs.join('\n'))}`, fix: 'Fix each error, then run cmod check again.' }
  return { status: 'pass', text: `tsc ${typescript.version} found no type errors with ${configs.join(' and ')}` }
}

async function writeClaudeTypes(plugin: Plugin): Promise<void> {
  const types = join(plugin.root, '.claude-plugin', 'types', 'tsconfig.json')
  if (existsSync(types)) return
  const scratch = await mkdtemp(join(tmpdir(), 'cmod-claude-'))
  try {
    const cmodPlugin = join(scratch, 'cmod')
    await writeAtomically(join(cmodPlugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'cmod', version: cmodVersion })}\n`)
    const pluginDirs = plugin.name === 'cmod' ? [plugin.root] : [cmodPlugin, plugin.root]
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, 'config'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    const claude = spawn(['claude', ...pluginDirs.flatMap((folder) => ['--plugin-dir', folder]), '-p', 'ok'], { cwd: plugin.root, env, stdout: 'ignore', stderr: 'ignore' })
    const timeout = setTimeout(() => claude.kill(), 60_000)
    await claude.exited
    clearTimeout(timeout)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (!existsSync(types)) throw new Error(`Claude Code wrote no .claude-plugin/types/ when cmod loaded ${plugin.name} with claude --plugin-dir. Run cmod link, start claude once, then run cmod check again.`)
}

async function checkLint(plugin: Plugin): Promise<Result> {
  const tool = await fetchTool(oxlint)
  if (typeof tool !== 'string') return tool
  const config = existsSync(join(plugin.root, '.oxlintrc.json')) ? ['-c', join(plugin.root, '.oxlintrc.json')] : []
  const result = await runTool(tool, [...config, '--ignore-pattern', 'cli/**', '.'], plugin.root)
  if (result.exitCode !== 0) return { status: 'fail', text: `oxlint ${oxlint.version} found problems:\n${indent(result.output)}`, fix: 'Fix each problem, or change the rule in .oxlintrc.json, then run cmod check again.' }
  return { status: 'pass', text: `oxlint ${oxlint.version} found no problems${config.length > 0 ? ' with the mod\'s .oxlintrc.json' : ''}` }
}

async function checkTests(plugin: Plugin): Promise<Result> {
  const tests = (await testFiles(plugin)).filter((test) => !test.isKitTest).map((test) => `./${relative(plugin.root, test.path)}`)
  if (tests.length === 0) return { status: 'skip', text: 'No *.test.ts files for bun test, so no tests ran' }
  const bun = bunArgv('test', ...tests)
  const result = await capture(bun.argv, { cwd: plugin.root, env: bun.env })
  const summary = (result.stdout + result.stderr).trim().split('\n').filter((line) => /^\s*\d+ (pass|fail)/.test(line)).map((line) => line.trim()).join(', ')
  if (result.exitCode !== 0) return { status: 'fail', text: `bun test failed:\n${indent(result.stdout + result.stderr)}`, fix: 'Fix the failing tests, then run cmod check again.' }
  return { status: 'pass', text: `bun test passed: ${summary}` }
}

async function checkPluginTests(plugin: Plugin): Promise<Result> {
  if (!(await testFiles(plugin)).some((test) => test.isKitTest)) return { status: 'skip', text: 'No test imports claude-code/testing, so claude plugin test had nothing to run' }
  const result = await capture(['claude', 'plugin', 'test', plugin.root])
  if (result.exitCode !== 0) return { status: 'fail', text: `claude plugin test failed:\n${indent(result.stdout + result.stderr)}`, fix: 'Fix the failing tests, then run cmod check again.' }
  return { status: 'pass', text: 'claude plugin test passed' }
}

async function testFiles(plugin: Plugin): Promise<{ path: string; isKitTest: boolean }[]> {
  const tests = []
  for (const path of await walk(plugin.root)) {
    if (/\.test\.[jt]sx?$/.test(path)) tests.push({ path, isKitTest: importsOf((await readText(path)) ?? '').includes('claude-code/testing') })
  }
  return tests
}

async function checkNameConflict(plugin: Plugin): Promise<Result> {
  const skills = dirname(plugin.root)
  if (!(skills.endsWith(`${sep}.claude${sep}skills`) && existsSync(join(dirname(dirname(skills)), '.git')))) return { status: 'pass', text: `${plugin.name} is not project-scope, so no project plugin can hide it` }
  const taken = (await listPlugins()).filter((installed) => installed.name === plugin.name && !installed.id.endsWith('@skills-dir')).map((installed) => installed.id)
  for (const folder of await linkedFolders()) {
    const manifest = await readJson(join(folder, '.claude-plugin', 'plugin.json'))
    if (isObject(manifest) && manifest['name'] === plugin.name) taken.push(`${folder} (linked)`)
  }
  if (taken.length > 0) return { status: 'fail', text: `${taken.join(', ')} has the name ${plugin.name} and hides this project plugin`, fix: `Rename this plugin or ${taken.join(', ')}, then run cmod check again.` }
  return { status: 'pass', text: `No other plugin is named ${plugin.name}` }
}

async function fetchTool(tool: { name: string; version: string; program: string }): Promise<string | Result> {
  const folder = storePath('tools', tool.program, tool.version)
  const program = join(folder, 'node_modules', '.bin', tool.program)
  if (existsSync(program)) return program
  try {
    await writeAtomically(join(folder, 'package.json'), `${JSON.stringify({ private: true, dependencies: { [tool.name]: tool.version } }, null, 2)}\n`)
    const bun = bunArgv('install')
    await runCommand(bun.argv, { cwd: folder, env: bun.env })
    return program
  } catch (error) {
    return { status: 'skip', text: `${tool.program} skipped: fetching ${tool.name} ${tool.version} failed (${messageOf(error).split('\n')[0]}). Check the network, then run cmod check again.` }
  }
}

async function runTool(program: string, args: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const bun = bunArgv(program, ...args)
  const result = await capture(bun.argv, { cwd, env: bun.env })
  return { exitCode: result.exitCode, output: (result.stdout + result.stderr).trim() }
}

async function walk(folder: string, root = folder): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory() && !skippedFolders.has(entry.name) && path !== join(root, 'cli') && path !== join(root, '.claude-plugin', 'types')) files.push(...(await walk(path, root)))
    if (entry.isFile()) files.push(path)
  }
  return files
}

function importsOf(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
  return [...source.matchAll(pattern)].map((match) => match[1] as string)
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:') || builtinModules.includes(specifier.split('/')[0] as string)
}

function indent(text: string): string {
  return text.trim().split('\n').slice(-30).map((line) => `      ${line}`).join('\n')
}
