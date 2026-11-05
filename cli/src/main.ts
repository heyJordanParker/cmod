import { version } from '../package.json'
import { messageOf } from '@cmodjs/core/src/utils/text.js'

type Command = { summary: string; help: string; run(argv: string[]): Promise<number> }

const commands: Record<string, () => Promise<Command>> = {
  install: () => import('./commands/install.js'),
  list: () => import('./commands/list.js'),
  update: () => import('./commands/update.js'),
  remove: () => import('./commands/remove.js'),
  enable: () => import('./commands/enable.js'),
  disable: () => import('./commands/disable.js'),
  try: () => import('./commands/try.js'),
  new: () => import('./commands/new.js'),
  link: () => import('./commands/link.js'),
  unlink: () => import('./commands/unlink.js'),
  check: () => import('./commands/check.js'),
  publish: () => import('./commands/publish.js'),
  setup: () => import('./commands/setup.js'),
  teardown: () => import('./commands/teardown.js'),
  option: () => import('./commands/option.js'),
  options: () => import('./commands/options.js'),
  hotkey: () => import('./commands/hotkey.js'),
  secret: () => import('./commands/secret.js'),
  settings: () => import('./commands/settings.js'),
  rules: () => import('./commands/rules.js'),
  device: () => import('./commands/device.js'),
  history: () => import('./commands/history.js'),
  log: () => import('./commands/log.js'),
  task: () => import('./commands/task.js'),
  watch: () => import('./commands/watch.js'),
  web: () => import('./commands/web.js'),
  program: () => import('./commands/program.js'),
  download: () => import('./commands/download.js'),
}

const changesRules: readonly string[] = ['install', 'update', 'remove', 'enable', 'disable', 'link', 'unlink', 'setup', 'teardown']

const changesPlugins: readonly string[] = ['install', 'update', 'remove', 'enable', 'disable', 'link', 'unlink', 'try']

async function overview(): Promise<string> {
  const lines = await Promise.all(Object.entries(commands).map(async ([name, load]) => `  ${name.padEnd(12)}${(await load()).summary}`))
  return `Usage: cmod <command> [arguments]

Claude Mod Manager installs, builds, checks, and publishes Claude Code mods.

${lines.join('\n')}

Run cmod <command> --help for a command's arguments. cmod --version prints the version.`
}

const [name, ...argv] = process.argv.slice(2)
const ownArguments = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv

if (name === '--version' || name === '-v') {
  process.stdout.write(`${version}\n`)
} else if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
  process.stdout.write(`${await overview()}\n`)
} else if (!Object.hasOwn(commands, name)) {
  process.stderr.write(`cmod: "${name}" is not a command.\n\n${await overview()}\n`)
  process.exitCode = 1
} else {
  const command = await (commands[name] as () => Promise<Command>)()
  if (ownArguments.includes('--help') || ownArguments.includes('-h')) {
    process.stdout.write(`${command.help}\n`)
  } else {
    try {
      process.exitCode = await command.run(argv)
      if (process.exitCode === 0 && changesRules.includes(name)) {
        const { syncRules } = await import('./rules.js')
        await syncRules(process.cwd())
      }
    } catch (error) {
      const { interruptProgress } = await import('./progress.js')
      interruptProgress()
      process.stderr.write(`cmod ${name}: ${messageOf(error)}\n`)
      process.exitCode = 1
    } finally {
      if (changesPlugins.includes(name)) {
        const { markPluginsChanged } = await import('./store.js')
        await markPluginsChanged()
      }
    }
  }
}
