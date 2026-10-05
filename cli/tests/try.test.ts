import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, cmodInTerminal, cmodPluginListed, deleteTemporaryHomes, temporaryHome, writeFiles } from './cmod.js'

afterEach(deleteTemporaryHomes)

async function waitForTeardown(home: string): Promise<void> {
  for (let waited = 0; waited < 10_000 && !(existsSync(join(home, 'uninstalls')) && leftovers(home).length === 0); waited += 100) await Bun.sleep(100)
}

function leftovers(home: string): string[] {
  const store = join(home, '.local/share/cmod')
  const paths = [
    join(home, '.local/bin/hello'),
    join(store, 'bin/hello'),
    join(store, 'data/hello-mod'),
    join(store, 'records/hello-mod.json'),
    join(store, 'records/hello-mod.json.lock'),
    join(store, 'uninstall/hello-mod'),
  ]
  return paths.filter((path) => existsSync(path)).map((path) => path.slice(home.length + 1))
}

async function approvals(home: string): Promise<unknown> {
  return JSON.parse((await readFile(join(home, '.local/share/cmod/consent.json'), 'utf8').catch(() => undefined)) ?? '{}')
}

const helloMod = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
  'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
  'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
  'setup/uninstall.sh': '#!/bin/sh\necho uninstalled >> "$HOME/uninstalls"\n',
}

const sessionListingSetup = `for path in .local/share/cmod/records/hello-mod.json .local/share/cmod/data/hello-mod/runs .local/bin/hello; do
  test -e "$HOME/$path" && echo "$path" >> "$HOME/during"
done`

test('try prints each step for a mod with no steps, and passes the arguments after -- to claude', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, {
    'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"'),
    'demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const result = await cmod(home, 'try', root, '--', '-p', 'hello')

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe(
    [
      'Installing packages for demo…',
      '✔ demo has no packages to install',
      'Installing the CMod plugin into Claude Code…',
      '✔ Installed cmod@cmod into Claude Code',
      'Installing demo…',
      '✔ demo 0.1.0 is ready',
      `claude --plugin-dir ${root} -p hello`,
      'Uninstalling demo…',
      '✔ Removed what CMod set up for demo',
      '',
    ].join('\n'),
  )
})

test('cmod try loads a fresh cmod new mod in a home without the CMod plugin', async () => {
  const home = await temporaryHome()
  const root = join(home, 'my-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering([], 'true') })
  expect((await cmod(home, 'new', 'my-mod')).exitCode).toBe(0)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe(
    `plugin list --json\nplugin marketplace list --json\nplugin marketplace add heyJordanParker/cmod\nplugin install cmod@cmod --json\n--plugin-dir ${root}\n`,
  )
})

test('cmod try sets the mod up itself, and leaves no record, data, approval or program link after the session', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, sessionListingSetup) })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, helloMod)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'during'), 'utf8')).toBe('.local/share/cmod/records/hello-mod.json\n.local/share/cmod/data/hello-mod/runs\n.local/bin/hello\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(store, 'records/hello-mod.json'), join(store, 'data/hello-mod'), join(store, 'uninstall/hello-mod'), join(store, 'bin/hello'), join(home, '.local/bin/hello')]) {
    expect({ path, exists: existsSync(path) }).toEqual({ path, exists: false })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('cmod try tears down when the terminal sends SIGHUP', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'kill -HUP $PPID $$') })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, helloMod)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(129)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(store, 'records/hello-mod.json'), join(store, 'uninstall/hello-mod'), join(home, '.local/bin/hello')]) {
    expect({ path, exists: existsSync(path) }).toEqual({ path, exists: false })
  }
})

test('cmod try starts no session and tears nothing down when the mod is not set up', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"') })
  await writeFiles(root, helloMod)

  const result = await cmod(home, 'try', root)

  expect(result.exitCode).toBe(10)
  expect(result.stdout).not.toContain('claude --plugin-dir')
  expect(result.stdout).not.toContain('tear down')
})

test('Ctrl+C before the session starts skips the session and sets nothing up', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, {
    'bin/claude': `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json") kill -INT $PPID; sleep 1; echo '${JSON.stringify(cmodPluginListed)}' ;;
  "--plugin-dir "*) ;;
  *) exit 1 ;;
esac
`,
  })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, helloMod)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).not.toContain('--plugin-dir')
  expect(existsSync(join(store, 'records/hello-mod.json'))).toBe(false)
  expect(existsSync(join(store, 'data/hello-mod'))).toBe(false)
  expect(await approvals(home)).toEqual({})
})

test('cmod try after a held SIGTERM installs nothing', async () => {
  const home = await temporaryHome()
  const root = join(home, 'demo')
  await writeFiles(home, {
    'bin/claude': `#!/bin/sh
echo "$*" >> "$HOME/claude-calls"
case "$*" in
  "plugin list --json") kill -TERM $PPID; sleep 0.3; echo '[]' ;;
  "plugin marketplace list --json") echo '[]' ;;
  "plugin marketplace add heyJordanParker/cmod") ;;
  "plugin install cmod@"*" --json") echo '{"outcome":"ok","message":"Installed"}' ;;
  *) exit 1 ;;
esac
`,
    'demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
  })

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(143)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).toBe('plugin list --json\n')
  expect(result.stdout).not.toContain('Cancelled the install step')
  expect(existsSync(join(home, '.local/share/cmod/records/demo.json'))).toBe(false)
})

test('a signal to the process group during the install step of cmod try leaves no program, approval or data', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"') })
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, { ...helloMod, 'setup/install.sh': '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n' })

  const result = await cmodInTerminal(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled the install step of hello-mod on SIGINT.')
  expect(result.output).not.toContain('Fix the step')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).not.toContain('--plugin-dir')
  expect(leftovers(home)).toEqual([])
  expect(await approvals(home)).toEqual({})
})

test('a signal to cmod try during the install step skips the session and tears the mod down', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"') })
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, { ...helloMod, 'setup/install.sh': '#!/bin/sh\nkill -HUP $PPID\nsleep 1\necho ran >> "$CMOD_DATA/runs"\n' })

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(129)
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).not.toContain('--plugin-dir')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  expect(leftovers(home)).toEqual([])
  expect(await approvals(home)).toEqual({})
})

test('a throw after the program is linked in cmod try removes the program', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"') })
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n', '.local/share/cmod/uninstall': 'a file where the saved uninstall steps go\n' })
  await writeFiles(root, helloMod)

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toStartWith('cmod try: ')
  expect(await readFile(join(home, 'claude-calls'), 'utf8')).not.toContain('--plugin-dir')
  expect(leftovers(home)).toEqual([])
  expect(await approvals(home)).toEqual({})
})

test('a closed terminal while the cmod try session runs leaves no record or claim', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'kill -KILL $(cat "$HOME/terminal-pid")\nsleep 2\necho "outlived the terminal" > "$HOME/session"') })
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, { ...helloMod, 'setup/uninstall.sh': '#!/bin/sh\necho "progress 1 2 Removing"\nsleep 0.5\necho "progress 2 2 Removed"\necho uninstalled >> "$HOME/uninstalls"\n' })

  await cmodInTerminal(home, 'try', root, '--yes')
  await waitForTeardown(home)

  expect(existsSync(join(home, 'session'))).toBe(false)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  expect(leftovers(home)).toEqual([])
  expect(await approvals(home)).toEqual({})
}, 15_000)

test("a closed terminal during cmod try's teardown leaves no record or claim", async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'true') })
  await writeFiles(home, { '.local/share/cmod/bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, { ...helloMod, 'setup/uninstall.sh': '#!/bin/sh\nkill -KILL $(cat "$HOME/terminal-pid")\necho "progress 1 2 Removing"\nsleep 0.5\necho "progress 2 2 Removed"\necho uninstalled >> "$HOME/uninstalls"\n' })

  await cmodInTerminal(home, 'try', root, '--yes')
  await waitForTeardown(home)

  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  expect(leftovers(home)).toEqual([])
  expect(await approvals(home)).toEqual({})
}, 15_000)

test('a failed install in cmod try leaves no approval or data', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, 'echo "claude $*"') })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, { ...helloMod, 'setup/install.sh': '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\necho "brew: no such formula" >&2\nexit 3\n' })

  const result = await cmod(home, 'try', root, '--yes')

  expect(result.exitCode).toBe(1)
  expect(result.stdout).not.toContain('claude --plugin-dir')
  expect(result.stdout).not.toContain('tear down')
  for (const path of [join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json'), join(home, '.local/bin/hello')]) {
    expect({ path, exists: existsSync(path) }).toEqual({ path, exists: false })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test('cmod try refuses a mod another checkout has set up', async () => {
  const home = await temporaryHome()
  const installed = join(home, 'installed/hello-mod')
  const checkout = join(home, 'Developer/hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(installed, helloMod)
  await writeFiles(checkout, helloMod)
  expect((await cmod(home, 'setup', installed, '--yes')).exitCode).toBe(0)
  const record = await readFile(join(store, 'records/hello-mod.json'), 'utf8')

  const result = await cmod(home, 'try', checkout, '--yes')

  expect(result.stderr).toBe('cmod try: hello-mod is set up from ~/installed/hello-mod, so cmod try would replace its record and saved uninstall step. Run cmod remove hello-mod, or cmod unlink ~/installed/hello-mod for a linked checkout, then run cmod try again.\n')
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(home, 'claude-calls'))).toBe(false)
  expect(await readFile(join(store, 'records/hello-mod.json'), 'utf8')).toBe(record)
  expect(await readFile(join(store, 'uninstall/hello-mod/root/setup/uninstall.sh'), 'utf8')).toBe(helloMod['setup/uninstall.sh'])
})

test('cmod try keeps the setup of a checkout that was set up before it', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(home, { 'bin/claude': claudeAnswering(cmodPluginListed, sessionListingSetup) })
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, helloMod)
  expect((await cmod(home, 'setup', root, '--yes')).exitCode).toBe(0)

  const result = await cmod(home, 'try', root)

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(home, 'during'), 'utf8')).toBe('.local/share/cmod/records/hello-mod.json\n.local/share/cmod/data/hello-mod/runs\n.local/bin/hello\n')
  expect(existsSync(join(home, 'uninstalls'))).toBe(false)
  expect(existsSync(join(store, 'records/hello-mod.json'))).toBe(true)
})
