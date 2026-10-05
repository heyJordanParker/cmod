import { version } from '../package.json'
import * as check from './commands/check.js'
import * as download from './commands/download.js'
import * as install from './commands/install.js'
import * as link from './commands/link.js'
import * as list from './commands/list.js'
import * as newMod from './commands/new.js'
import * as publish from './commands/publish.js'
import * as remove from './commands/remove.js'
import * as setup from './commands/setup.js'
import * as teardown from './commands/teardown.js'
import * as tryMod from './commands/try.js'
import * as unlink from './commands/unlink.js'
import * as update from './commands/update.js'
import { interruptProgress } from './progress.js'

type Command = { summary: string; help: string; run(argv: string[]): Promise<number> }

const commands: Record<string, Command> = {
  install,
  list,
  update,
  remove,
  try: tryMod,
  new: newMod,
  link,
  unlink,
  check,
  publish,
  setup,
  teardown,
  download,
}

const overview = `Usage: cmod <command> [arguments]

Claude Mod Manager installs, builds, checks, and publishes Claude Code mods.

${Object.entries(commands)
  .map(([name, command]) => `  ${name.padEnd(10)}${command.summary}`)
  .join('\n')}

Run cmod <command> --help for a command's arguments. cmod --version prints the version.`

const [name, ...argv] = process.argv.slice(2)
const ownArguments = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv

if (name === '--version' || name === '-v') {
  process.stdout.write(`${version}\n`)
} else if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
  process.stdout.write(`${overview}\n`)
} else if (!Object.hasOwn(commands, name)) {
  process.stderr.write(`cmod: "${name}" is not a command.\n\n${overview}\n`)
  process.exitCode = 1
} else {
  const command = commands[name] as Command
  if (ownArguments.includes('--help') || ownArguments.includes('-h')) {
    process.stdout.write(`${command.help}\n`)
  } else {
    try {
      process.exitCode = await command.run(argv)
    } catch (error) {
      interruptProgress()
      process.stderr.write(`cmod ${name}: ${(error as Error).message}\n`)
      process.exitCode = 1
    }
  }
}
