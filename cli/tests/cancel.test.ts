import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ifMissing, listFiles } from '../src/files.js'
import { cmod, cmodInTerminal, cmodOfStep, createMod, createProgramMod, deleteTemporaryHomes, hashOf, helloBuild, isGone, serveRelease, sha256Sums, startCmod, temporaryHome, waitFor, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

test.concurrent('Ctrl+C during the install step of cmod setup leaves no program link', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n',
  })

  const result = await cmodInTerminal(home, 'setup', root)

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled on SIGINT. The install step of hello-mod exited 130.')
  expect(result.output).not.toContain('Fix the install step')
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test.concurrent('Ctrl+C during the install step runs the uninstall step and leaves nothing', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n')
  const store = join(home, '.local/share/cmod')

  const result = await cmodInTerminal(home, 'setup', root)

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled on SIGINT. The install step of demo exited 130.')
  expect(result.output).toContain('The uninstall step of demo undid the install.')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${root}\n`)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test.concurrent('a fresh install step that traps Ctrl+C and exits 1 runs the uninstall step', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, `#!/bin/sh\ntrap 'exit 1' INT\necho partial >> "$CMOD_DATA/partial"\nkill -INT 0\nsleep 1\n`)
  const store = join(home, '.local/share/cmod')

  const result = await cmodInTerminal(home, 'setup', root)

  expect(result.exitCode).toBe(130)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${root}\n`)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test.concurrent('a fresh install step that fails runs the uninstall step and leaves nothing', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho partial >> "$CMOD_DATA/partial"\necho "brew: no such formula" >&2\nexit 3\n')
  const store = join(home, '.local/share/cmod')

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain('The uninstall step of demo undid the install.')
  expect(result.stdout).toContain('✘ The install step of demo exited 3: brew: no such formula. Fix the install step, then run the command again.\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe(`uninstalled from ${root}\n`)
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test.concurrent('a fresh install whose uninstall step fails says parts may remain', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "curl: could not resolve host" >&2\nexit 7\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "zsh: no such file" >&2\nexit 2\n' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe(
    'log curl: could not resolve host\nlog zsh: no such file\nfailed 7\tThe install step of demo exited 7: curl: could not resolve host. The uninstall step then exited 2: zsh: no such file, so parts of the install may remain.\n',
  )
  expect(result.exitCode).toBe(1)
})

test.concurrent('a fresh install that exits with no stderr and whose uninstall step fails names both exits in order', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\nexit 7\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\necho "zsh: no such file" >&2\nexit 2\n' })

  const result = await cmod(home, 'setup', root, '--events')

  expect(result.stdout).toBe('log zsh: no such file\nfailed 7\tThe install step of demo exited 7. The uninstall step then exited 2: zsh: no such file, so parts of the install may remain.\n')
  expect(result.exitCode).toBe(1)
})

test.concurrent("Ctrl+C during the undo keeps the install step's exit code and reason", async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "brew: no such formula" >&2\nexit 3\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nkill -INT 0\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n' })

  const result = await cmodInTerminal(home, 'setup', root)

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled on SIGINT. The install step of demo exited 3: brew: no such formula.')
  expect(result.output).not.toContain('Cancelled the install step')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
})

test.concurrent("Ctrl+C during an upgrade's install step keeps the version its record names", async () => {
  const home = await temporaryHome()
  const root = await createMod(home, '#!/bin/sh\necho "history the user built" > "$HOME/history.db"\n')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\nrm -f "$HOME/history.db"\necho "uninstalled $CMOD_VERSION" >> "$HOME/uninstalls"\n' })
  const store = join(home, '.local/share/cmod')
  const installed = await hashOf(root)
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  const savedStep = await readFile(join(store, 'uninstall/demo/root/setup/uninstall.sh'), 'utf8')
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': '#!/bin/sh\nkill -INT 0\nsleep 1\n' })

  const result = await cmodInTerminal(home, 'setup', root)

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled on SIGINT. The install step of demo exited 130.')
  expect(await readFile(join(home, 'history.db'), 'utf8')).toBe('history the user built\n')
  expect(existsSync(join(home, 'uninstalls'))).toBe(false)
  expect(JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))).toMatchObject({ version: '0.1.0', scriptsSha256: installed })
  expect(await readFile(join(store, 'uninstall/demo/root/setup/uninstall.sh'), 'utf8')).toBe(savedStep)
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({ demo: [installed] })
})

test.concurrent('cleanup after a cancel revokes the approval while another process holds the consent lock', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, `#!/bin/sh
(trap '' INT HUP TERM; exec sleep 2 </dev/null >/dev/null 2>&1) &
mkdir -p "$HOME/.local/share/cmod/consent.json.lock"
printf '%s' "$(TZ=UTC LC_ALL=C ps -o lstart= -p $! | sed 's/ *$//')" > "$HOME/.local/share/cmod/consent.json.lock/$!"
kill -INT 0
sleep 1
`)
  const store = join(home, '.local/share/cmod')

  const result = await cmodInTerminal(home, 'setup', root)

  expect(result.exitCode).toBe(130)
  expect(result.output).toContain('Cancelled on SIGINT. The install step of demo exited 130.')
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
  for (const path of [join(store, 'data/demo'), join(store, 'records/demo.json'), join(store, 'consent.json.lock')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
}, 15_000)

test.concurrent("Ctrl+C during cmod remove's uninstall step still removes the mod", async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
    'setup/install.sh': '#!/bin/sh\necho ran >> "$CMOD_DATA/runs"\n',
    'setup/uninstall.sh': '#!/bin/sh\nkill -INT 0\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n',
  })
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)

  const result = await cmodInTerminal(home, 'remove', 'hello-mod')

  expect(result.exitCode).toBe(130)
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json'), join(store, 'records/hello-mod.json.lock'), join(store, 'uninstall/hello-mod')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

const blockRecordWrite = `#!/bin/sh\n${cmodOfStep}\nmkdir "$HOME/.local/share/cmod/records/demo.json.$cmod.tmp"\n`

test.concurrent('a record write that fails after the uninstall step is saved deletes the saved step', async () => {
  const home = await temporaryHome()
  const root = await createMod(home, blockRecordWrite)
  const store = join(home, '.local/share/cmod')

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(1)
  expect(existsSync(join(store, 'records/demo.json'))).toBe(false)
  expect(await readdir(join(store, 'uninstall')).catch(ifMissing([]))).toEqual([])
})

test.concurrent('a record write that fails in an upgrade keeps the new saved uninstall step, because the new install step ran', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  const newUninstall = '#!/bin/sh\necho "the new uninstall" >> "$HOME/uninstalls"\n'
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), 'setup/install.sh': blockRecordWrite, 'setup/uninstall.sh': newUninstall })

  const result = await cmod(home, 'setup', root)

  expect(result.exitCode).toBe(1)
  expect(await readdir(join(store, 'uninstall'))).toEqual(['demo'])
  expect(await readFile(join(store, 'uninstall/demo/root/setup/uninstall.sh'), 'utf8')).toBe(newUninstall)
  expect(JSON.parse(await readFile(join(store, 'records/demo.json'), 'utf8'))).toMatchObject({ version: '0.1.0' })
})

test.concurrent('a crash between the saved step and the record leaves a record whose uninstall step exists', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  expect((await cmod(home, 'setup', root)).exitCode).toBe(0)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }), ...Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`setup/lib/${index}.sh`, `echo ${index}\n`])) })
  const recordFile = join(store, 'records/demo.json')

  const setup = startCmod(home, 'setup', root)
  while (setup.child.exitCode === null && !(await readFile(recordFile, 'utf8')).includes('"version": "0.2.0"')) await Bun.sleep(0)
  setup.child.kill('SIGKILL')
  await setup.done

  const record = JSON.parse(await readFile(recordFile, 'utf8'))
  expect(record.version).toBe('0.2.0')
  expect(existsSync(record.uninstall)).toBe(true)
  expect(await listFiles(join(dirname(record.uninstall), 'root/setup'))).toEqual(await listFiles(join(root, 'setup')))
}, 30_000)

test.concurrent('Ctrl+C while cmod setup downloads the program installs nothing', async () => {
  const home = await temporaryHome()
  using server = serveRelease({ ...helloBuild, SHA256SUMS: sha256Sums(helloBuild) }, 1000)
  const root = await createProgramMod(home, `${server.url.origin}/owner/hello-mod`)
  const store = join(home, '.local/share/cmod')

  const setup = startCmod(home, 'setup', root)
  await setup.waitForOutput('Downloading hello 0.2.0')
  setup.child.kill('SIGINT')
  const result = await setup.done

  expect(result.exitCode).toBe(130)
  expect(result.stdout).toContain('Cancelled setting up hello-mod on SIGINT, before its install step started.')
  expect(result.stdout).not.toContain('Cancelled on')
  for (const path of [join(home, '.local/bin/hello'), join(store, 'bin/hello'), join(store, 'data/hello-mod'), join(store, 'records/hello-mod.json')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({})
})

test.concurrent('SIGTERM to cmod setup --events during the install step leaves a recorded mod', async () => {
  const home = await temporaryHome()
  const root = join(home, 'hello-mod')
  const store = join(home, '.local/share/cmod')
  await writeFiles(store, { 'bin/hello/0.2.0/hello': '#!/bin/sh\necho hello\n' })
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'hello-mod', version: '0.2.0' }),
    'package.json': JSON.stringify({ name: 'hello-mod', cmod: { program: 'hello', install: './setup/install.sh', uninstall: './setup/uninstall.sh' } }),
    'setup/install.sh': '#!/bin/sh\ntouch "$HOME/installing"\nsleep 1\necho ran >> "$CMOD_DATA/runs"\n',
    'setup/uninstall.sh': '#!/bin/sh\necho uninstalled >> "$HOME/uninstalls"\n',
  })

  const setup = startCmod(home, 'setup', root, '--events')
  await waitFor(join(home, 'installing'))
  setup.child.kill('SIGTERM')
  const result = await setup.done

  expect(result.exitCode).toBe(143)
  expect(JSON.parse(await readFile(join(store, 'records/hello-mod.json'), 'utf8'))).toMatchObject({ version: '0.2.0', program: 'hello', uninstall: join(store, 'uninstall/hello-mod/uninstall.sh') })
  expect(existsSync(join(store, 'uninstall/hello-mod/uninstall.sh'))).toBe(true)
  expect(await readlink(join(home, '.local/bin/hello'))).toBe(join(store, 'bin/hello/0.2.0/hello'))
  expect(await readFile(join(store, 'data/hello-mod/runs'), 'utf8')).toBe('ran\n')
  expect(JSON.parse(await readFile(join(store, 'consent.json'), 'utf8'))).toEqual({ 'hello-mod': [await hashOf(root)] })
})

test.concurrent('SIGTERM to cmod teardown --events during the uninstall step still removes the mod', async () => {
  const home = await temporaryHome()
  const root = await createMod(home)
  const store = join(home, '.local/share/cmod')
  await writeFiles(root, { 'setup/uninstall.sh': '#!/bin/sh\ntouch "$HOME/uninstalling"\nsleep 1\necho uninstalled >> "$HOME/uninstalls"\n' })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)

  const teardown = startCmod(home, 'teardown', 'demo', '--events')
  await waitFor(join(home, 'uninstalling'))
  teardown.child.kill('SIGTERM')
  const result = await teardown.done

  expect(result.exitCode).toBe(143)
  expect(result.stdout).toBe('done demo\n')
  expect(await readFile(join(home, 'uninstalls'), 'utf8')).toBe('uninstalled\n')
  for (const path of [join(store, 'records/demo.json'), join(store, 'records/demo.json.lock'), join(store, 'data/demo'), join(store, 'uninstall/demo')]) {
    expect({ path, isGone: await isGone(path) }).toEqual({ path, isGone: true })
  }
})
