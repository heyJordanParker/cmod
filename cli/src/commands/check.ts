import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { isObject, permissionWords, scriptPaths, scriptsSha256 } from '@cmodjs/core/src/records.js'
import { formatOf, readMetadata, sidecarSuffix } from '@cmodjs/core/src/utils/metadata.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { addClaudeApi, listPlugins, testPlugin, validatePlugin } from '../claude.js'
import { listFiles, readJson, readText, writeAtomically } from '../files.js'
import { cmodFloor, installPackages, readDeclared, readPlugin, writeCmodFloor, writeHotkeys, writeUserConfig, type Declared, type Plugin } from '../plugin.js'
import { bunArgv, capture, run as runCommand } from '../process.js'
import { declaredMachines, machineWords, unsupportedSystems } from '../program.js'
import { startProgress } from '../progress.js'
import { bundledHooks } from './publish.js'
import { linkedFolders } from '../settings.js'
import { storePath } from '../store.js'

export const summary = 'Run every check on a mod, each failure with its fix.'

export const help = `Usage: cmod check [path]

${summary}

Runs every check this machine can run on the mod at path (default: the current
folder): installs its packages, checks its layout and that each step runs a
script, checks each download covers the machines its "os" and "cpu" list,
writes the options defineMod declares into plugin.json userConfig and its
hotkeys into package.json "cmod.hotkeys",
bundles its hooks module as cmod publish does, validates it with Claude
Code, compiles it against Claude Code's API with tsconfig.json and, when it
exists, tests/tsconfig.json,
lints it, runs its tests with bun test and with claude plugin test, and checks
its name. Each failure names its fix.`

type Result = { status: 'pass' | 'skip'; text: string } | { status: 'fail'; text: string; fix: string }

type Check = { heading: string; run(plugin: Plugin): Promise<Result> }

const typescript = { name: 'typescript', version: '7.0.2', program: 'tsc' }
const oxlint = { name: 'oxlint', version: '1.86.0', program: 'oxlint' }
const skippedFolders = new Set(['node_modules', '.git', 'target', '.target'])
const componentNames = ['skills', 'commands', 'agents', 'hooks', 'monitors', 'output-styles', 'themes', 'workflows', 'bin', 'settings.json', '.mcp.json', '.lsp.json', 'SKILL.md']

const checks: Check[] = [
  { heading: 'Installing packages', run: checkPackages },
  { heading: 'Checking the layout', run: checkLayout },
  { heading: 'Checking the steps', run: checkSteps },
  { heading: 'Checking the machines', run: checkMachines },
  { heading: 'Reading the permissions', run: checkPermissions },
  { heading: 'Reading the metadata', run: checkMetadata },
  { heading: 'Writing the options and hotkeys', run: checkOptions },
  { heading: 'Pinning the cmod plugin', run: checkCmodFloor },
  { heading: 'Checking imports', run: checkImports },
  { heading: 'Looking for prebuilt binaries', run: checkBinaries },
  { heading: 'Bundling the hooks', run: checkBundle },
  { heading: 'Validating with Claude Code', run: checkValidate },
  { heading: "Compiling against Claude Code's API", run: checkCompiles },
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
    if (!(await installPackages(plugin))) return { status: 'skip', text: 'No package.json, so no packages to install' }
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

async function checkMachines(plugin: Plugin): Promise<Result> {
  const unsupported = unsupportedSystems(plugin.packageJson)
  const fix = 'cmod runs mods on "darwin" and "linux", on "arm64" and "x64". List only those in the "os" and "cpu" keys of package.json.'
  if (unsupported.length > 0) return { status: 'fail', text: `package.json "os" and "cpu" list ${unsupported.join(', ')}, which cmod does not run mods on`, fix }
  const declared = declaredMachines(plugin.packageJson)
  if (declared.length === 0) return { status: 'fail', text: 'package.json "os" and "cpu" leave no machine for the mod to run on', fix }
  const install = plugin.steps.install === undefined ? '' : (await Promise.all(scriptPaths(plugin.steps.install).map((path) => readText(join(plugin.root, path))))).join('\n')
  const problems = downloadsIn(install).flatMap(({ program, listed }) => declared.filter((each) => !listed.includes(each)).map((each) => `${program} has no download for ${each}`))
  if (problems.length > 0) return { status: 'fail', text: `The install step misses a download the mod needs on ${machineWords(declared)}`, fix: `${problems.join(', ')}. Add a <machine> <url> <sha256> line for each, or list only the machines it downloads for in the "os" and "cpu" keys of package.json.` }
  return { status: 'pass', text: `${plugin.name} runs on ${machineWords(declared)}${install === '' ? '' : ', and the install step downloads a program for each'}` }
}

function downloadsIn(script: string): { program: string; listed: string[] }[] {
  return [...script.replace(/\\\n/g, ' ').matchAll(/\bcmod download\s+(\S+)((?:[ \t]+\S+)*)/g)].map((match) => {
    const words = (match[2] ?? '').trim().split(/\s+/)
    return { program: match[1] as string, listed: words.filter((_, index) => index % 3 === 0) }
  })
}

async function checkPermissions(plugin: Plugin): Promise<Result> {
  let permissions = plugin.steps.permissions ?? []
  let sources: Source[]
  try {
    sources = await sourcesOf(plugin.root)
  } catch (error) {
    return { status: 'fail', text: messageOf(error), fix: 'Fix the syntax error, then run cmod check again.' }
  }
  const hasPermissionCheck = /\bregisterPermissionCheck\s*\(/.test(sources.find(({ file }) => file === registerFile)?.code ?? '')
  const hearing = hasPermissionCheck ? undefined : sources.find(({ code }) => permissionListener.test(code) || answersPermissions(code))
  if (hearing !== undefined) return { status: 'fail', text: `${hearing.file} hears Claude Code's permission check, and hooks/register.ts does not call registerPermissionCheck`, fix: 'Add registerPermissionCheck(addHook) after registerMod in hooks/register.ts, then run cmod check again.' }
  const isAdded = hasPermissionCheck && !permissions.includes('approve') && sources.some(({ code }) => approvesCalls(code))
  if (isAdded) {
    const path = join(plugin.root, 'package.json')
    const manifest = (await readJson(path)) as Record<string, unknown>
    const steps = isObject(manifest['cmod']) ? manifest['cmod'] : {}
    const declared = isObject(steps['permissions']) ? steps['permissions'] : {}
    await writeAtomically(path, `${JSON.stringify({ ...manifest, cmod: { ...steps, permissions: { ...declared, approve: true } } }, null, 2)}\n`)
    permissions = [...permissions, 'approve']
  }
  if (existsSync(join(plugin.root, 'rules')) && !permissions.includes('prompt')) return { status: 'fail', text: 'rules/ holds rules Claude reads, and package.json "cmod" does not ask for "prompt"', fix: 'Add "permissions": { "prompt": true } to package.json "cmod", then run cmod check again.' }
  if (permissions.length === 0) return { status: 'skip', text: 'package.json "cmod" asks for no permissions' }
  const added = isAdded ? 'Added "approve": true to package.json "cmod", because the mod allows or asks on Claude Code\'s permission check\n    ' : ''
  const unlisted = permissions.includes('approve') ? "\n    Anthropic's plugin directory does not list a mod that approves Claude's tool calls" : ''
  return { status: 'pass', text: `${added}At install the person grants: ${permissions.map(permissionWords).join('; ')}${unlisted}` }
}

const registerFile = join('hooks', 'register.ts')

const scriptFile = /\.(m?[jt]sx?|cts|cjs)$/

const permissionListener = /\bonPermission(?:Check|Request)\s*\(/

const answersPermissions = (code: string) => /\bbeforePermission(?:Check|Request)\s*\(/.test(code) || /\bimport\s*\{[^}]*\bpermissions\b[^}]*\}\s*from\s*['"][^'"]*\/jobs\/permissions\.js['"]/.test(code)

const approvesCalls = (code: string) => answersPermissions(code) && /\b(?:allow\s*:\s*true|ask\s*:)/.test(code)

type Source = { readonly file: string; readonly code: string }

async function sourcesOf(root: string): Promise<Source[]> {
  const source = join(root, 'src')
  const files = [join(root, registerFile), ...(existsSync(source) ? await walk(source, root) : [])].filter((file) => scriptFile.test(file) && !/\.test\.[^.]+$/.test(file))
  return Promise.all(files.map(async (file) => ({ file: relative(root, file), code: codeOf(relative(root, file), (await readText(file)) ?? '') })))
}

function transpilerOf(file: string): Bun.Transpiler {
  const loader = file.slice(file.lastIndexOf('.') + 1).replace(/^[mc]/, '')
  return new Bun.Transpiler({ loader: loader === 'js' ? 'jsx' : (loader as 'jsx' | 'ts' | 'tsx') })
}

function parsed<Value>(file: string, read: () => Value): Value {
  try {
    return read()
  } catch (error) {
    throw new Error(`${file} does not parse: ${messageOf(error)}`)
  }
}

function codeOf(file: string, text: string): string {
  return parsed(file, () => transpilerOf(file).transformSync(withoutShebang(text)))
}

function importsIn(file: string, text: string): string[] {
  return parsed(file, () => transpilerOf(file).scanImports(withoutShebang(text)).map((each) => each.path))
}

function withoutShebang(text: string): string {
  return text.startsWith('#!') ? text.replace(/^#![^\n]*/, '') : text
}

async function checkMetadata(plugin: Plugin): Promise<Result> {
  const problems: string[] = []
  let count = 0
  for (const file of await walk(plugin.root)) {
    if (file.endsWith(sidecarSuffix)) continue
    const extensionless = !basename(file).includes('.')
    const format = formatOf(file, extensionless ? (await readText(file))?.split('\n', 1)[0] : undefined)
    const holder = format.type === 'sidecar' ? `${file}${sidecarSuffix}` : file
    if (!existsSync(holder)) continue
    const text = (await readText(holder)) ?? ''
    try {
      if (Object.keys(readMetadata(text, format).metadata).length > 0) count += 1
    } catch (error) {
      problems.push(`${relative(plugin.root, holder)} ${messageOf(error)}`)
    }
  }
  if (problems.length > 0) return { status: 'fail', text: `${problems.length} file${problems.length === 1 ? '' : 's'} with metadata cmod cannot read`, fix: problems.join('\n    fix: ') }
  if (count === 0) return { status: 'skip', text: 'No file in the mod holds metadata' }
  return { status: 'pass', text: `cmod reads the metadata of ${count === 1 ? '1 file' : `${count} files`}` }
}

async function checkOptions(plugin: Plugin): Promise<Result> {
  let declared: Declared
  try {
    declared = await readDeclared(plugin.root)
  } catch (error) {
    return { status: 'fail', text: messageOf(error), fix: 'Fix the error, then run cmod check again.' }
  }
  if (declared.type === 'no-hooks') return { status: 'skip', text: 'No hooks module in hooks/hooks.json, so no options or hotkeys to read' }
  if (declared.type === 'no-core') return { status: 'skip', text: 'No @cmodjs/core in node_modules, so no options or hotkeys to read' }
  if (declared.type === 'old-core') return { status: 'skip', text: 'The @cmodjs/core in node_modules has no options. Raise it in package.json to read them' }
  const options = Object.keys(declared.userConfig)
  const hotkeys = Object.keys(declared.hotkeys)
  const isOptionsWritten = await writeUserConfig(plugin.root, declared.userConfig)
  const isHotkeysWritten = await writeHotkeys(plugin.root, declared.hotkeys)
  const lines = [
    ...(options.length === 0 ? (isOptionsWritten ? ['Removed userConfig from plugin.json, as defineMod declares no options'] : []) : [`${isOptionsWritten ? 'Wrote' : 'plugin.json userConfig holds'} the ${options.length === 1 ? 'option' : `${options.length} options`} defineMod declares${isOptionsWritten ? ' into plugin.json userConfig' : ''}: ${options.join(', ')}`]),
    ...(hotkeys.length === 0 ? (isHotkeysWritten ? ['Removed "cmod.hotkeys" from package.json, as defineMod declares no hotkeys'] : []) : [`${isHotkeysWritten ? 'Wrote' : 'package.json "cmod.hotkeys" holds'} the ${hotkeys.length === 1 ? 'hotkey' : `${hotkeys.length} hotkeys`} defineMod declares${isHotkeysWritten ? ' into package.json "cmod.hotkeys"' : ''}: ${hotkeys.join(', ')}`]),
  ]
  if (lines.length === 0) return { status: 'skip', text: 'defineMod declares no options and no hotkeys' }
  return { status: 'pass', text: lines.join('\n    ') }
}

async function checkCmodFloor(plugin: Plugin): Promise<Result> {
  const floor = await cmodFloor(plugin)
  if (floor === undefined) return { status: 'skip', text: plugin.name === 'cmod' ? 'The cmod plugin depends on no cmod' : 'No @cmodjs/core 4 or later in node_modules, so the mod keeps its own cmod range' }
  const isWritten = await writeCmodFloor(plugin.root, floor)
  return { status: 'pass', text: `${isWritten ? 'Wrote' : 'plugin.json holds'} the cmod dependency "${floor}", the @cmodjs/core this mod bundles, so every newer cmod runs it` }
}

async function checkImports(plugin: Plugin): Promise<Result> {
  const problems: string[] = []
  const cli = join(plugin.root, 'cli') + sep
  for (const file of await walk(plugin.root)) {
    if (!scriptFile.test(file)) continue
    const isSource = file.startsWith(join(plugin.root, 'src') + sep)
    let specifiers: string[]
    try {
      specifiers = importsIn(relative(plugin.root, file), (await readText(file)) ?? '')
    } catch (error) {
      problems.push(messageOf(error))
      continue
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith('.') && resolve(dirname(file), specifier).startsWith(cli)) problems.push(`${relative(plugin.root, file)} imports ${specifier} from cli/, which the release leaves out: move the shared code into src/`)
      if (isSource && isBuiltin(specifier)) problems.push(`${relative(plugin.root, file)} imports ${specifier}: Claude Code runs mods with no Node or Bun, so use fs, process, or http, imported from @cmodjs/core/mod.js`)
    }
  }
  if (problems.length > 0) return { status: 'fail', text: `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} with the mod's imports`, fix: problems.join('\n    fix: ') }
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
    const result = await validatePlugin(target)
    if (result.exitCode !== 0) failures.push(`${relative(plugin.root, target)}:\n${(result.stdout + result.stderr).trim().split('\n').map((line) => `      ${line}`).join('\n')}`)
  }
  if (failures.length > 0) return { status: 'fail', text: `claude plugin validate --strict failed on ${failures.join('\n')}`, fix: 'Fix each error and warning it names, then run cmod check again.' }
  return { status: 'pass', text: `claude plugin validate --strict passed on ${targets.map((target) => relative(plugin.root, target)).join(' and ')}` }
}

async function checkCompiles(plugin: Plugin): Promise<Result> {
  if (!existsSync(join(plugin.root, 'tsconfig.json'))) return { status: 'skip', text: 'Compiling skipped: the mod has no tsconfig.json' }
  try {
    await addClaudeApi(plugin)
  } catch (error) {
    return { status: 'skip', text: `Compiling skipped: ${messageOf(error)}` }
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

async function checkLint(plugin: Plugin): Promise<Result> {
  const tool = await fetchTool(oxlint)
  if (typeof tool !== 'string') return tool
  const config = existsSync(join(plugin.root, '.oxlintrc.json')) ? ['-c', join(plugin.root, '.oxlintrc.json')] : []
  const result = await runTool(tool, [...config, '--ignore-pattern', 'cli/**', '--ignore-pattern', 'node_modules/**', '.'], plugin.root)
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
  const result = await testPlugin(plugin.root)
  if (result.exitCode !== 0) return { status: 'fail', text: `claude plugin test failed:\n${indent(result.stdout + result.stderr)}`, fix: 'Fix the failing tests, then run cmod check again.' }
  return { status: 'pass', text: 'claude plugin test passed' }
}

async function testFiles(plugin: Plugin): Promise<{ path: string; isKitTest: boolean }[]> {
  const tests = []
  const root = await testRoot(plugin.root)
  if (!existsSync(root)) return []
  for (const path of await walk(root, plugin.root)) {
    if (/\.test\.[jt]sx?$/.test(path)) tests.push({ path, isKitTest: /['"]claude-code\/testing['"]/.test((await readText(path)) ?? '') })
  }
  return tests
}

async function testRoot(folder: string): Promise<string> {
  const config = await readText(join(folder, 'bunfig.toml'))
  const test: unknown = config === undefined ? undefined : Bun.TOML.parse(config)
  const root = isObject(test) && isObject(test['test']) ? test['test']['root'] : undefined
  return typeof root === 'string' ? join(folder, root) : folder
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

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:') || builtinModules.includes(specifier.split('/')[0] as string)
}

function indent(text: string): string {
  return text.trim().split('\n').slice(-30).map((line) => `      ${line}`).join('\n')
}
