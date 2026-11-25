import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { chmod, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, cmodExecutable, cmodPluginListed, cmodWith, createMod, deleteTemporaryHomes, isGone, servedChanges, spawned, spawningTestLimitMs, startCmod, startProcess, temporaryHome, writeFiles, until } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
afterAll(deleteTemporaryHomes)

const fakeServer = `#!/bin/sh
trap 'echo "stop $$" >> "$HOME/server-log"; exit 0' TERM
echo "start $$" >> "$HOME/server-log"
echo "unix:$HOME/$$.sock"
while :; do sleep 0.1; done
`

const crashServer = `#!/bin/sh
echo "no port is free" >&2
exit 3
`

const instances = (home: string) => join(home, '.local/share/cmod/instances/demo')

async function serverHome(): Promise<string> {
  const home = await temporaryHome()
  await writeFiles(home, { 'bin/fake-server': fakeServer, 'bin/crash-server': crashServer })
  return home
}

function serverLog(home: string): string[] {
  return existsSync(join(home, 'server-log')) ? readFileSync(join(home, 'server-log'), 'utf8').trim().split('\n') : []
}

function serverIds(home: string, event: 'start' | 'stop'): string[] {
  return serverLog(home)
    .filter((line) => line.startsWith(`${event} `))
    .map((line) => line.slice(event.length + 1))
}

function owner(home: string): number {
  return Number(readdirSync(join(instances(home), 'fake-server.json.lock'))[0])
}

test.concurrent('two cmod program processes started together run one copy, and both print its address', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'demo', '--', 'fake-server')
  const second = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length > 0)
  const [copy] = serverIds(home, 'start')

  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  await second.waitForOutput(`unix:${home}/${copy}.sock`)
  await Bun.sleep(1000)
  expect(serverIds(home, 'start')).toEqual([copy as string])
  expect(JSON.parse(readFileSync(join(instances(home), 'fake-server.json'), 'utf8'))).toMatchObject({ address: `unix:${home}/${copy}.sock`, pid: Number(copy) })
  first.child.kill()
  second.child.kill()
  await Promise.all([first.done, second.done])
})

test.concurrent("SIGTERM to the owner stops its copy, and the waiter starts the next copy and prints that copy's address", async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const second = startCmod(home, 'program', 'demo', '--', 'fake-server')
  const [copy] = serverIds(home, 'start')
  await second.waitForOutput(`unix:${home}/${copy}.sock`)

  first.child.kill('SIGTERM')
  expect((await first.done).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string

  await second.waitForOutput(`unix:${home}/${next}.sock`)
  expect(serverLog(home)).toEqual([`start ${copy}`, `stop ${copy}`, `start ${next}`])
  second.child.kill()
  await second.done
})

test.concurrent('the holder tells cmod/Programs when it writes the instance file and when it deletes it, and a waiting cmod program prints the next address it reads then', async () => {
  const home = await serverHome()
  const serve = await servedChanges(home)
  const changes = await serve.listen('cmod/Programs', { mod: 'demo' })
  const first = startCmod(home, 'program', 'demo', '--', 'fake-server')
  expect(await changes()).toEqual({ mod: 'demo', program: 'fake-server' })
  const [copy] = serverIds(home, 'start')
  expect(JSON.parse(readFileSync(join(instances(home), 'fake-server.json'), 'utf8'))).toMatchObject({ address: `unix:${home}/${copy}.sock` })
  const second = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await second.waitForOutput(`unix:${home}/${copy}.sock`)

  first.child.kill('SIGTERM')
  expect(await changes()).toEqual({ mod: 'demo', program: 'fake-server' })
  expect(existsSync(join(instances(home), 'fake-server.json'))).toBe(false)
  expect(await changes()).toEqual({ mod: 'demo', program: 'fake-server' })
  const next = serverIds(home, 'start')[1] as string
  await second.waitForOutput(`unix:${home}/${next}.sock`)
  second.child.kill()
  await Promise.all([first.done, second.done])
})

test.concurrent('cmod program --no-wait with no holder runs the copy and prints its address', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'demo', '--no-wait', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  expect(owner(home)).toBe(first.child.pid)
  first.child.kill()
  await first.done
})

test.concurrent("cmod program --no-wait beside a holder touches the holder's lock file, prints held, and exits 0 without a second copy", async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')
  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  const holder = join(instances(home), 'fake-server.json.lock', String(first.child.pid))
  utimesSync(holder, new Date(0), new Date(0))

  const { exitCode, stdout } = await cmod(home, 'program', 'demo', '--no-wait', '--', 'fake-server')

  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('held')
  expect(Date.now() - statSync(holder).mtimeMs).toBeLessThan(5000)
  expect(serverIds(home, 'start')).toEqual([copy as string])
  first.child.kill()
  await first.done
})

test.concurrent("cmod program --no-wait of a program with a service record, as a session on another copy of the mod runs it, prints held and starts no copy while the service's holder is away, so the copy never lives in a session", async () => {
  const home = await serverHome()
  await writeFiles(home, { '.local/share/cmod/services/demo/fake-server.json': JSON.stringify({ label: 'com.claudemodmanager.demo.fake-server', unit: join(home, 'unit.plist') }) })

  const { exitCode, stdout } = await cmod(home, 'program', 'demo', '--no-wait', '--', 'fake-server')

  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('held')
  expect(serverIds(home, 'start')).toEqual([])
  expect(existsSync(join(instances(home), 'fake-server.json'))).toBe(false)
})

test.concurrent('the holder touches its file in the lock every 5 seconds', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const holder = join(instances(home), 'fake-server.json.lock', String(first.child.pid))
  utimesSync(holder, new Date(0), new Date(0))

  await until(() => statSync(holder).mtimeMs > 0)

  expect(Date.now() - statSync(holder).mtimeMs).toBeLessThan(5000)
  first.child.kill()
  await first.done
})

test.concurrent('after the owner is killed with SIGKILL, the next owner stops the orphaned copy before it starts its own', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const second = startCmod(home, 'program', 'demo', '--', 'fake-server')
  const [orphan] = serverIds(home, 'start')
  await second.waitForOutput(`unix:${home}/${orphan}.sock`)
  expect(owner(home)).toBe(first.child.pid)

  first.child.kill('SIGKILL')
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string

  expect(serverLog(home)).toEqual([`start ${orphan}`, `stop ${orphan}`, `start ${next}`])
  await second.waitForOutput(`unix:${home}/${next}.sock`)
  second.child.kill()
  await second.done
})

test.concurrent('the owner stops its copy and gives up the election when its parent process dies', async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodExecutable })
  const parent = startProcess(home, ['sh', '-c', 'cmod program demo -- fake-server & wait'])
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  parent.kill('SIGKILL')
  await until(() => serverIds(home, 'stop').length === 1)

  expect(serverLog(home)).toEqual([`start ${copy}`, `stop ${copy}`])
  await until(() => !existsSync(join(instances(home), 'fake-server.json.lock')))
  expect(existsSync(join(instances(home), 'fake-server.json'))).toBe(false)
})

test.concurrent("SIGTERM stops the owner's copy even after the session's working folder is deleted", async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodExecutable, 'project/.keep': '' })
  const first = startProcess(home, [join(home, 'bin/cmod'), 'program', 'demo', '--', 'fake-server'], join(home, 'project'))
  await until(() => serverIds(home, 'start').length === 1)
  await rm(join(home, 'project'), { recursive: true })

  first.kill('SIGTERM')

  expect(await first.exited).toBe(0)
  expect(serverIds(home, 'stop')).toEqual(serverIds(home, 'start'))
})

test.concurrent('the copy runs without CLAUDE_CODE_SESSION_ID, because it serves every session', async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/session-server': '#!/bin/sh\necho "session ${CLAUDE_CODE_SESSION_ID:-none}" >> "$HOME/server-log"\necho "unix:$HOME/$$.sock"\n' })

  const { exitCode } = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'session-1' }, 'program', 'demo', '--', 'session-server')

  expect(exitCode).toBe(0)
  expect(serverLog(home)).toEqual(['session none'])
})

const foldersServer = '#!/bin/sh\necho "data $CMOD_DATA" >> "$HOME/server-log"\necho "cache $CMOD_CACHE" >> "$HOME/server-log"\necho "unix:$HOME/$$.sock"\n'

test.concurrent("the copy runs with CMOD_DATA and CMOD_CACHE, the mod's data folder and cache folder, as an install step gets them", async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/folders-server': foldersServer })

  const { exitCode } = await cmodWith(home, { XDG_CACHE_HOME: join(home, 'caches') }, 'program', 'demo', '--', 'folders-server')

  expect(exitCode).toBe(0)
  expect(serverLog(home)).toEqual([`data ${home}/.local/share/cmod/data/demo`, `cache ${home}/caches/cmod/demo`])
})

test.concurrent("cmod teardown deletes the removed mod's instances folder and keeps another mod's", async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/instances/demo/fake-server.json': '{}\n', '.local/share/cmod/instances/notes/fake-server.json': '{}\n' })

  const result = await cmod(home, 'teardown', 'demo', '--events')

  expect(result.exitCode).toBe(0)
  expect(existsSync(instances(home))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/instances/notes/fake-server.json'))).toBe(true)
})

test.concurrent("a copy that crashes makes the owner exit with the copy's exit code and pass its standard error through", async () => {
  const home = await serverHome()

  const { exitCode, stderr } = await cmod(home, 'program', 'demo', '--', 'crash-server')

  expect(exitCode).toBe(3)
  expect(stderr).toContain('no port is free')
  expect(existsSync(join(instances(home), 'crash-server.json.lock'))).toBe(false)
})

async function linkedServerHome(): Promise<{ home: string; checkout: string }> {
  const home = await serverHome()
  const checkout = join(home, 'Developer', 'demo')
  await writeFiles(home, { 'server-build': fakeServer })
  await writeFiles(checkout, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'cli/package.json': JSON.stringify({ name: 'linked-server', cmod: { build: `mkdir -p dist && cp "$HOME/server-build" dist/linked-server-${process.platform}-${process.arch}`, output: 'dist' } }),
  })
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  return { home, checkout }
}

test.concurrent("a build that changes the held program's file stops the copy and ends its holder with 0, and the session's next cmod program starts the new build and names its address in the instance file", async () => {
  const { home, checkout } = await linkedServerHome()
  const holder = startCmod(home, 'program', 'demo', '--no-wait', '--', 'linked-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [old] = serverIds(home, 'start')
  await holder.waitForOutput(`unix:${home}/${old}.sock`)

  await writeFiles(home, { 'server-build': fakeServer.replace('.sock', '-rebuilt.sock') })
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  expect((await holder.done).exitCode).toBe(0)
  expect(serverLog(home)).toEqual([`start ${old}`, `stop ${old}`])
  expect(existsSync(join(instances(home), 'linked-server.json'))).toBe(false)

  const next = startCmod(home, 'program', 'demo', '--no-wait', '--', 'linked-server')
  await until(() => serverIds(home, 'start').length === 2)
  const copy = serverIds(home, 'start')[1] as string
  await next.waitForOutput(`unix:${home}/${copy}-rebuilt.sock`)
  expect(JSON.parse(readFileSync(join(instances(home), 'linked-server.json'), 'utf8'))).toMatchObject({ address: `unix:${home}/${copy}-rebuilt.sock`, pid: Number(copy) })
  next.child.kill()
  await next.done
})

test.concurrent("a build that writes the same bytes keeps the held program's copy running", async () => {
  const { home, checkout } = await linkedServerHome()
  const holder = startCmod(home, 'program', 'demo', '--', 'linked-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')
  await holder.waitForOutput(`unix:${home}/${copy}.sock`)

  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  await Bun.sleep(7000)

  expect(serverLog(home)).toEqual([`start ${copy}`])
  holder.child.kill()
  await holder.done
})

const holderWithoutBuildCheck = `import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
const [file, program] = process.argv.slice(2)
const startTime = (pid) => Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).stdout.toString().trim()
mkdirSync(file + '.lock', { recursive: true })
writeFileSync(file + '.lock/' + process.pid, startTime(process.pid))
const copy = Bun.spawn([program], { stdout: 'pipe' })
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    copy.kill()
  }
}, 1000).unref()
const reader = copy.stdout.getReader()
let output = ''
while (!output.includes('\\n')) output += new TextDecoder().decode((await reader.read()).value)
writeFileSync(file, JSON.stringify({ address: output.split('\\n')[0], pid: copy.pid, started: startTime(copy.pid) }) + '\\n')
await copy.exited
rmSync(file, { force: true })
rmSync(file + '.lock', { recursive: true, force: true })
`

async function startHolderWithoutBuildCheck(home: string, instance: string, program: string): Promise<ReturnType<typeof startProcess>> {
  await writeFiles(home, { 'holder-without-build-check.mjs': holderWithoutBuildCheck })
  const holder = startProcess(home, [process.execPath, join(home, 'holder-without-build-check.mjs'), instance, join(home, '.local/share/cmod/programs', program)])
  await until(() => existsSync(instance))
  return holder
}

test.concurrent("a build that changes the held program's file stops the copy of a holder that never checks for a new build, as an older cmod program's holder does, and the waiting holder starts the new build", async () => {
  const { home, checkout } = await linkedServerHome()
  const old = await startHolderWithoutBuildCheck(home, join(instances(home), 'linked-server.json'), 'linked-server')
  const [first] = serverIds(home, 'start')
  const waiting = startCmod(home, 'program', 'demo', '--', 'linked-server')
  await waiting.waitForOutput(`unix:${home}/${first}.sock`)

  await writeFiles(home, { 'server-build': fakeServer.replace('.sock', '-rebuilt.sock') })
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string

  await waiting.waitForOutput(`unix:${home}/${next}-rebuilt.sock`)
  expect(await old.exited).toBe(0)
  expect(serverLog(home)).toEqual([`start ${first}`, `stop ${first}`, `start ${next}`])
  waiting.child.kill()
  await waiting.done
})

test.concurrent("cmod download of a held program, which an install step runs, stops the copy of a holder with no build check, and the waiting holder starts the downloaded file", async () => {
  const home = await serverHome()
  const builds: Record<string, string> = { first: fakeServer, second: fakeServer.replace('.sock', '-downloaded.sock') }
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => new Response(builds[new URL(request.url).pathname.slice(1)]) })
  const download = (build: string) =>
    cmodWith(home, { CMOD_DATA: join(home, '.local/share/cmod/data/demo'), CMOD_CACHE: join(home, '.cache/cmod/demo') }, 'download', 'fake-server', `${process.platform}-${process.arch}`, `${server.url}${build}`, new Bun.CryptoHasher('sha256').update(builds[build] as string).digest('hex'))
  try {
    expect((await download('first')).exitCode).toBe(0)
    const old = await startHolderWithoutBuildCheck(home, join(instances(home), 'fake-server.json'), 'fake-server')
    const [first] = serverIds(home, 'start')
    const waiting = startCmod(home, 'program', 'demo', '--', 'fake-server')
    await waiting.waitForOutput(`unix:${home}/${first}.sock`)

    expect((await download('second')).exitCode).toBe(0)
    await until(() => serverIds(home, 'start').length === 2)
    const next = serverIds(home, 'start')[1] as string

    await waiting.waitForOutput(`unix:${home}/${next}-downloaded.sock`)
    expect(await old.exited).toBe(0)
    expect(serverLog(home)).toEqual([`start ${first}`, `stop ${first}`, `start ${next}`])
    waiting.child.kill()
    await waiting.done
  } finally {
    await server.stop(true)
  }
})

const uid = process.getuid?.() ?? 0

const isMac = process.platform === 'darwin'

const label = (mod: string) => `com.claudemodmanager.${mod}.fake-server`

const unitOf = (home: string, mod: string) => (isMac ? join(home, 'Library/LaunchAgents', `${label(mod)}.plist`) : join(home, '.config/systemd/user', `${label(mod)}.service`))

const servicesOf = (home: string, mod: string) => join(home, '.local/share/cmod/services', mod)

const pathVariableOf = (home: string) => `${join(home, '.local/share/cmod/programs')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`

function serviceCalls(home: string): string[] {
  return existsSync(join(home, 'service-calls')) ? readFileSync(join(home, 'service-calls'), 'utf8').trim().split('\n') : []
}

async function writeExecutables(home: string, files: Record<string, string>): Promise<void> {
  await writeFiles(home, files)
  for (const path of Object.keys(files)) await chmod(join(home, path), 0o755)
}

async function serviceHome(): Promise<string> {
  const home = await serverHome()
  await writeExecutables(home, { '.local/share/cmod/programs/cmod': cmodExecutable, '.local/share/cmod/programs/fake-server': fakeServer })
  return home
}

const listingServer = `#!/bin/sh
trap 'echo "stop $$" >> "$HOME/server-log"; exit 0' TERM
echo "start $$" >> "$HOME/server-log"
echo "unix:$HOME/$$.sock"
while :; do cmod list --json > /dev/null 2>> "$HOME/listing-errors" & wait $!; echo "$?" >> "$HOME/listings"; sleep 0.2; done
`

function listings(home: string): string[] {
  return existsSync(join(home, 'listings')) ? readFileSync(join(home, 'listings'), 'utf8').trim().split('\n') : []
}

async function versionedServerHome(install = '#!/bin/sh\n'): Promise<{ home: string; root: string; instance: string }> {
  const home = await serviceHome()
  const root = join(home, 'demo')
  await writeFiles(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0' }),
    'package.json': JSON.stringify({ name: 'demo', cmod: { program: 'fake-server', install: './setup/install.sh' } }),
    'setup/install.sh': install,
  })
  await writeExecutables(home, { '.local/share/cmod/bin/fake-server/0.1.0/fake-server': fakeServer, '.local/share/cmod/bin/fake-server/0.2.0/fake-server': fakeServer.replace('.sock', '-0.2.0.sock') })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  return { home, root, instance: join(home, '.local/share/cmod/instances/demo/fake-server.json') }
}

test.concurrent('cmod program --service with no cmod serve counts the service as started within a few seconds of its instance file, never at the 15-second deadline', async () => {
  const home = await serviceHome()

  const { exitCode, stdout } = await cmod(home, 'program', 'demo', '--service', '--', 'fake-server', '--port', '0')
  const heldAt = Date.now()

  expect([exitCode, stdout]).toEqual([0, 'held\n'])
  expect(heldAt - statSync(join(home, '.local/share/cmod/instances/demo/fake-server.json')).mtimeMs).toBeLessThan(5000)
})

test.concurrent("cmod program --service writes a launchd agent on macOS, which sends standard error to the service's log in the cmod store, and a systemd user service on Linux, that runs cmod program with the program's command, home, and a restart on every exit, loads it, and prints held once the service holds the lock", async () => {
  const home = await serviceHome()
  const path = pathVariableOf(home)
  const cmodProgram = join(home, '.local/share/cmod/programs/cmod')

  const { exitCode, stdout } = await cmodWith(home, { DEMO_DEVICE: 'mac-1' }, 'program', 'demo', '--service', '--env', 'DEMO_DEVICE', '--', 'fake-server', '--port', '0')

  expect([exitCode, stdout]).toEqual([0, 'held\n'])
  if (isMac) {
    expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudemodmanager.demo.fake-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cmodProgram}</string>
    <string>program</string>
    <string>demo</string>
    <string>--</string>
    <string>fake-server</string>
    <string>--port</string>
    <string>0</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${path}</string>
    <key>CLAUDE_CODE_EXECPATH</key>
    <string>${home}/bin/claude</string>
    <key>DEMO_DEVICE</key>
    <string>mac-1</string>
  </dict>
  <key>StandardErrorPath</key>
  <string>${home}/.local/share/cmod/services/demo/fake-server.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`)
    expect(serviceCalls(home)).toEqual([`launchctl print gui/${uid}/${label('demo')}`, `launchctl bootstrap gui/${uid} ${unitOf(home, 'demo')}`])
  } else {
    expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toBe(`[Unit]
Description=fake-server of the demo mod, which cmod runs

[Service]
ExecStart="${cmodProgram}" "program" "demo" "--" "fake-server" "--port" "0"
Environment="HOME=${home}"
Environment="PATH=${path}"
Environment="CLAUDE_CODE_EXECPATH=${home}/bin/claude"
Environment="DEMO_DEVICE=mac-1"
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`)
    expect(serviceCalls(home)).toEqual(['systemctl --user daemon-reload', `systemctl --user enable ${label('demo')}.service`, `systemctl --user restart ${label('demo')}.service`])
  }
  expect(statSync(unitOf(home, 'demo')).mode & 0o777).toBe(0o600)
})

test.concurrent("cmod program --service --process-type Interactive gives the launchd agent that ProcessType, and --provides names each interface in the instance file and in the service's command", async () => {
  const home = await serviceHome()

  const { exitCode, stdout } = await cmod(home, 'program', 'demo', '--service', '--process-type', 'Interactive', '--provides', 'demo/Platform', '--', 'fake-server', '--port', '0')
  expect([exitCode, stdout]).toEqual([0, 'held\n'])
  await until(() => existsSync(join(home, '.local/share/cmod/instances/demo/fake-server.json')))
  const unit = readFileSync(unitOf(home, 'demo'), 'utf8')

  expect(JSON.parse(readFileSync(join(home, '.local/share/cmod/instances/demo/fake-server.json'), 'utf8'))).toMatchObject({ provides: ['demo/Platform'] })
  expect(unit).toContain(isMac ? '<string>--provides</string>\n    <string>demo/Platform</string>' : '"--provides" "demo/Platform"')
  expect(unit.includes('<key>ProcessType</key>\n  <string>Interactive</string>')).toBe(isMac)
})

test.concurrent('cmod program refuses a process type launchd has no class for, a process type without --service, and a provided name that is no interface name', async () => {
  const home = await serviceHome()

  const unknown = await cmod(home, 'program', 'demo', '--service', '--process-type', 'Urgent', '--', 'fake-server')
  const elected = await cmod(home, 'program', 'demo', '--no-wait', '--process-type', 'Interactive', '--', 'fake-server')
  const unnamed = await cmod(home, 'program', 'demo', '--no-wait', '--provides', 'Platform', '--', 'fake-server')

  expect([unknown.exitCode, unknown.stderr]).toEqual([1, 'cmod program: cmod program --process-type takes Interactive or Background, not Urgent.\n'])
  expect([elected.exitCode, elected.stderr]).toEqual([1, 'cmod program: cmod program --process-type names the launchd class of a service, so it goes with --service.\n'])
  expect([unnamed.exitCode, unnamed.stderr]).toEqual([1, 'cmod program: cmod program --provides takes an interface name, <mod>/<Name>, such as cmod/Sessions, not Platform.\n'])
})

test.concurrent("a cmod command the service's program runs finds the Claude Code of the session that wrote the service, though the service's PATH holds no claude", async () => {
  const home = await serviceHome()
  await writeExecutables(home, { '.local/share/cmod/programs/fake-server': listingServer })

  expect(await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  await until(() => listings(home).length > 0)

  expect(Bun.which('claude', { PATH: pathVariableOf(home) })).toBeNull()
  expect(listings(home)[0]).toBe('0')
  expect(readFileSync(join(home, 'claude-calls'), 'utf8')).toContain('plugin list --json\n')
})

test.concurrent("after Claude Code updates itself and deletes the version the service was written from, the service's cmod commands still find it, and a session on the new version leaves the service as it was", async () => {
  const home = await serviceHome()
  const versions = join(home, '.local/share/claude/versions')
  const launcher = join(home, '.local/bin/claude')
  await writeExecutables(home, { '.local/share/cmod/programs/fake-server': listingServer, '.local/share/claude/versions/2.1.318': claudeAnswering(cmodPluginListed) })
  await mkdir(join(home, '.local/bin'))
  await symlink(join(versions, '2.1.318'), launcher)
  expect(await cmodWith(home, { CLAUDE_CODE_EXECPATH: join(versions, '2.1.318') }, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const unit = readFileSync(unitOf(home, 'demo'), 'utf8')
  const loaded = serviceCalls(home).length

  await writeExecutables(home, { '.local/share/claude/versions/2.1.319': claudeAnswering(cmodPluginListed) })
  await rm(launcher)
  await symlink(join(versions, '2.1.319'), launcher)
  await rm(join(versions, '2.1.318'))
  const listed = listings(home).length
  await until(() => listings(home).length > listed + 2)

  expect(listings(home).at(-1)).toBe('0')
  expect(await cmodWith(home, { CLAUDE_CODE_EXECPATH: join(versions, '2.1.319') }, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toBe(unit)
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user start ${label('demo')}.service`])
})

test.concurrent('cmod program --service whose service holds nothing within 15 seconds removes the service and its record, and fails', async () => {
  const home = await serviceHome()
  await writeExecutables(home, { '.local/share/cmod/programs/cmod': '#!/bin/sh\necho "this cmod cannot start" >&2\nexit 1\n' })

  const { exitCode, stderr } = await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')

  expect(exitCode).toBe(1)
  expect(stderr).toContain(`the ${label('demo')} service did not start fake-server within 15 seconds, so cmod removed it.`)
  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(existsSync(join(servicesOf(home, 'demo'), 'fake-server.json'))).toBe(false)
  expect(await isGone(join(home, '.config/systemd/user/default.target.wants', `${label('demo')}.service`))).toBe(true)
  expect(serverIds(home, 'start')).toEqual([])
})

test.concurrent.skipIf(!isMac)("cmod program --service on macOS whose program exits at once fails with an error that names the service's log, and the log, which the removal keeps, holds the program's standard error", async () => {
  const home = await serviceHome()
  await writeExecutables(home, { '.local/share/cmod/programs/fake-server': '#!/bin/sh\necho boom >&2\nexit 1\n' })

  const { exitCode, stderr } = await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')

  expect(exitCode).toBe(1)
  expect(stderr).toContain(`the ${label('demo')} service did not start fake-server within 15 seconds, so cmod removed it. ~/.local/share/cmod/services/demo/fake-server.log shows why.`)
  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(readdirSync(servicesOf(home, 'demo'))).toEqual(['fake-server.log'])
  expect(new Set(readFileSync(join(servicesOf(home, 'demo'), 'fake-server.log'), 'utf8').trim().split('\n'))).toEqual(new Set(['boom']))
})

test.concurrent("a holder whose service's log grew past 1 MiB keeps only the last whole lines of its last 512 KiB before it starts the program, so a program that fails at every restart never fills the disk", async () => {
  const home = await serverHome()
  const log = join(home, '.local/share/cmod/services/demo/crash-server.log')
  const line = `${'x'.repeat(99)}\n`
  await writeFiles(home, { '.local/share/cmod/services/demo/crash-server.log': `${line.repeat(20_000)}last failure\n` })

  expect((await cmod(home, 'program', 'demo', '--', 'crash-server')).exitCode).toBe(3)

  const kept = readFileSync(log, 'utf8')
  expect(kept.length).toBeLessThanOrEqual(512 * 1024)
  expect(kept.startsWith(line)).toBe(true)
  expect(kept.endsWith(`${line}last failure\n`)).toBe(true)
})

test.concurrent("cmod program --service waits for the mod's lock before it writes or loads the service, so sessions that start the mod at once never load it beside each other or beside cmod setup", async () => {
  const home = await serviceHome()
  const holder = spawned(['tail', '-f', '/dev/null'])
  await writeFiles(join(home, '.local/share/cmod/records/demo.json.lock'), { [String(holder.pid)]: '' })
  const started = startCmod(home, 'program', 'demo', '--service', '--', 'fake-server')
  await started.waitForOutput('Waiting for ~/.local/share/cmod/records/demo.json.lock')

  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(serviceCalls(home)).toEqual([])
  holder.kill()
  await holder.exited
  expect(await started.done).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  expect(existsSync(unitOf(home, 'demo'))).toBe(true)
})

test.concurrent.skipIf(isMac)('cmod program --service whose systemd user service took the unit and then failed to start disables it, deletes its unit and its record, and fails with the error instead of running the program in the session', async () => {
  const home = await serviceHome()
  await writeFiles(home, { 'service-fails': '' })

  const { exitCode, stderr } = await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')

  expect(exitCode).toBe(1)
  expect(stderr).toContain(`Job for ${label('demo')}.service failed because start of the service was attempted too often.`)
  expect(await isGone(join(home, '.config/systemd/user/default.target.wants', `${label('demo')}.service`))).toBe(true)
  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(existsSync(servicesOf(home, 'demo'))).toBe(false)
  expect(serverIds(home, 'start')).toEqual([])
})

test.concurrent('a second cmod program --service of the same mod and program, from a session with another PATH, loads nothing again and runs no second copy', async () => {
  const home = await serviceHome()
  expect(await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const loaded = serviceCalls(home).length

  expect(await cmodWith(home, { PATH: `${join(home, 'bin')}:${join(home, 'project/.venv/bin')}:${process.env['PATH']}` }, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  await Bun.sleep(1000)
  expect(serverIds(home, 'start')).toHaveLength(1)
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user start ${label('demo')}.service`])
})

test.concurrent("cmod program --service gives the service the session's XDG_CONFIG_HOME and HERDR_APP_HOME, so cmod serve finds a Herdr home the person moved, and a second session with the same ones loads nothing again", async () => {
  const home = await serviceHome()
  const moved = { XDG_CONFIG_HOME: join(home, '.config'), HERDR_APP_HOME: join(home, 'herdr') }
  expect(await cmodWith(home, moved, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const written = statSync(unitOf(home, 'demo'))
  const loaded = serviceCalls(home).length

  expect(await cmodWith(home, moved, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  const unit = readFileSync(unitOf(home, 'demo'), 'utf8')
  expect([unit.includes(moved.XDG_CONFIG_HOME), unit.includes(moved.HERDR_APP_HOME)]).toEqual([true, true])
  expect([statSync(unitOf(home, 'demo')).ino, statSync(unitOf(home, 'demo')).mtimeMs]).toEqual([written.ino, written.mtimeMs])
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user start ${label('demo')}.service`])
})

test.concurrent("a service's program runs with the CMOD_DATA and CMOD_CACHE of the session that wrote the service, though the session moved its XDG_CACHE_HOME, and a second session with the same folders loads nothing again", async () => {
  const home = await serviceHome()
  await writeExecutables(home, { '.local/share/cmod/programs/fake-server': `${foldersServer.trimEnd()}\nwhile :; do sleep 0.1; done\n` })
  const moved = { XDG_CACHE_HOME: join(home, 'caches') }
  expect(await cmodWith(home, moved, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const written = statSync(unitOf(home, 'demo'))
  const loaded = serviceCalls(home).length

  expect(await cmodWith(home, moved, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  expect(serverLog(home)).toEqual([`data ${home}/.local/share/cmod/data/demo`, `cache ${home}/caches/cmod/demo`])
  expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toContain(moved.XDG_CACHE_HOME)
  expect([statSync(unitOf(home, 'demo')).ino, statSync(unitOf(home, 'demo')).mtimeMs]).toEqual([written.ino, written.mtimeMs])
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user start ${label('demo')}.service`])
})

test.concurrent("a session whose own values differ from the service's, its Claude Code or Herdr home, writes and loads nothing, so cmod serve keeps running", async () => {
  const home = await serviceHome()
  const own = (claude: string, herdr: string) => ({ CLAUDE_CODE_EXECPATH: join(home, claude), HERDR_APP_HOME: join(home, herdr), DEMO_DEVICE: 'mac-1' })
  await writeExecutables(home, { 'claude-a': claudeAnswering(cmodPluginListed), 'claude-b': claudeAnswering(cmodPluginListed) })
  expect(await cmodWith(home, own('claude-a', 'herdr-a'), 'program', 'demo', '--service', '--env', 'DEMO_DEVICE', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const unit = readFileSync(unitOf(home, 'demo'), 'utf8')
  const written = statSync(unitOf(home, 'demo'))
  const loaded = serviceCalls(home).length

  expect(await cmodWith(home, own('claude-b', 'herdr-b'), 'program', 'demo', '--service', '--env', 'DEMO_DEVICE', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toBe(unit)
  expect([statSync(unitOf(home, 'demo')).ino, statSync(unitOf(home, 'demo')).mtimeMs]).toEqual([written.ino, written.mtimeMs])
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user start ${label('demo')}.service`])
})

function expectReloaded(home: string, loaded: number): void {
  const calls = serviceCalls(home).slice(loaded)
  if (isMac) {
    expect(calls.slice(0, 2)).toEqual([`launchctl print gui/${uid}/${label('demo')}`, `launchctl bootout gui/${uid}/${label('demo')}`])
    expect(calls.slice(2, -1).every((call) => call === `launchctl print gui/${uid}/${label('demo')}`)).toBe(true)
    expect(calls.at(-1)).toBe(`launchctl bootstrap gui/${uid} ${unitOf(home, 'demo')}`)
  } else {
    expect(calls).toEqual(['systemctl --user daemon-reload', `systemctl --user enable ${label('demo')}.service`, `systemctl --user restart ${label('demo')}.service`])
  }
}

test.concurrent("a cmod program --service whose command changed rewrites the service and loads it again once the service manager let the old one go", async () => {
  const home = await serviceHome()
  expect(await cmod(home, 'program', 'demo', '--service', '--', 'fake-server', '--port', '1')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const loaded = serviceCalls(home).length

  const changed = await cmod(home, 'program', 'demo', '--service', '--', 'fake-server', '--port', '2')

  expect(changed).toMatchObject({ exitCode: 0, stdout: 'held\n', stderr: '' })
  expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toContain(isMac ? '<string>2</string>' : '"2"')
  expectReloaded(home, loaded)
})

test.concurrent("a mod whose declared environment value changed rewrites the service and loads it again once the service manager let the old one go", async () => {
  const home = await serviceHome()
  expect(await cmodWith(home, { DEMO_DEVICE: 'mac-1' }, 'program', 'demo', '--service', '--env', 'DEMO_DEVICE', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const loaded = serviceCalls(home).length

  const changed = await cmodWith(home, { DEMO_DEVICE: 'mac-2' }, 'program', 'demo', '--service', '--env', 'DEMO_DEVICE', '--', 'fake-server')

  expect(changed).toMatchObject({ exitCode: 0, stdout: 'held\n', stderr: '' })
  expect(readFileSync(unitOf(home, 'demo'), 'utf8')).toContain('mac-2')
  expectReloaded(home, loaded)
})

test.concurrent("cmod setup of a new version of a mod calls no service manager, and the service's holder restarts the copy once on the new program", async () => {
  const { home, root, instance } = await versionedServerHome()
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 1)
  const [old] = serverIds(home, 'start')
  const loaded = serviceCalls(home).length

  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string
  await until(() => existsSync(instance))

  expect(serverLog(home)).toEqual([`start ${old}`, `stop ${old}`, `start ${next}`])
  expect(JSON.parse(readFileSync(instance, 'utf8'))).toMatchObject({ address: `unix:${home}/${next}-0.2.0.sock`, pid: Number(next) })
  expect(serviceCalls(home).slice(loaded)).toEqual([])
})

test.concurrent('cmod setup of a new version stops the copy of the old version that a holder with no build check runs, and the waiting holder starts the new version', async () => {
  const { home, root, instance } = await versionedServerHome()
  const old = await startHolderWithoutBuildCheck(home, instance, 'fake-server')
  const [first] = serverIds(home, 'start')
  const waiting = startCmod(home, 'program', 'demo', '--', 'fake-server')
  await waiting.waitForOutput(`unix:${home}/${first}.sock`)

  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string

  await waiting.waitForOutput(`unix:${home}/${next}-0.2.0.sock`)
  expect(await old.exited).toBe(0)
  expect(serverLog(home)).toEqual([`start ${first}`, `stop ${first}`, `start ${next}`])
  waiting.child.kill()
  await waiting.done
})

test.concurrent("a new version whose install step fails links the old program back and stops the new version's copy, so the service runs the old program again", async () => {
  const failsOnceTheNewCopyRuns = `#!/bin/sh
[ "$CMOD_VERSION" = 0.2.0 ] || exit 0
tries=0
while [ $tries -lt 200 ] && ! grep -q 0.2.0.sock "$HOME/.local/share/cmod/instances/demo/fake-server.json" 2>/dev/null; do sleep 0.1; tries=$((tries + 1)); done
exit 1
`
  const { home, root, instance } = await versionedServerHome(failsOnceTheNewCopyRuns)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await until(() => existsSync(instance))

  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(1)
  await until(() => serverIds(home, 'start').length === 3 && existsSync(instance))

  const [first, failed, restored] = serverIds(home, 'start')
  expect(serverLog(home)).toEqual([`start ${first}`, `stop ${first}`, `start ${failed}`, `stop ${failed}`, `start ${restored}`])
  expect(JSON.parse(readFileSync(instance, 'utf8'))).toMatchObject({ address: `unix:${home}/${restored}.sock`, pid: Number(restored) })
})

test.concurrent("a build of a linked checkout that changes a service's program restarts the service on the new build", async () => {
  const { home, checkout } = await linkedServerHome()
  const instance = join(instances(home), 'linked-server.json')
  await writeExecutables(home, { '.local/share/cmod/programs/cmod': cmodExecutable })
  expect(await cmod(home, 'program', 'demo', '--service', '--', 'linked-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  await until(() => serverIds(home, 'start').length === 1)
  const [old] = serverIds(home, 'start')

  await writeFiles(home, { 'server-build': fakeServer.replace('.sock', '-rebuilt.sock') })
  expect((await cmod(home, 'link', checkout)).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 2)
  const next = serverIds(home, 'start')[1] as string
  await until(() => existsSync(instance))

  expect(serverLog(home)).toEqual([`start ${old}`, `stop ${old}`, `start ${next}`])
  expect(JSON.parse(readFileSync(instance, 'utf8'))).toMatchObject({ address: `unix:${home}/${next}-rebuilt.sock`, pid: Number(next) })
})

test.concurrent('cmod remove stops the service of the mod and deletes its unit and its record', async () => {
  const home = await serviceHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 1)
  const loaded = serviceCalls(home).length

  expect((await cmod(home, 'remove', 'demo')).exitCode).toBe(0)

  const calls = serviceCalls(home).slice(loaded)
  if (isMac) {
    expect(calls[0]).toBe(`launchctl bootout gui/${uid}/${label('demo')}`)
    expect([...new Set(calls.slice(1))]).toEqual([`launchctl print gui/${uid}/${label('demo')}`])
  } else {
    expect(calls).toEqual([`systemctl --user disable --now ${label('demo')}.service`, 'systemctl --user daemon-reload'])
  }
  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(existsSync(servicesOf(home, 'demo'))).toBe(false)
  await until(() => serverIds(home, 'stop').length === 1)
})

test.concurrent("cmod program --remove-service, which the first session of a mod's version without the program runs after cmod setup, stops the service and deletes its unit and its record", async () => {
  const home = await serviceHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 1)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  const loaded = serviceCalls(home).length

  expect(await cmod(home, 'program', 'demo', '--remove-service', '--', 'fake-server')).toEqual({ exitCode: 0, stdout: '', stderr: '' })

  const calls = serviceCalls(home).slice(loaded)
  if (isMac) {
    expect(calls[0]).toBe(`launchctl bootout gui/${uid}/${label('demo')}`)
    expect([...new Set(calls.slice(1))]).toEqual([`launchctl print gui/${uid}/${label('demo')}`])
  } else {
    expect(calls).toEqual([`systemctl --user disable --now ${label('demo')}.service`, 'systemctl --user daemon-reload'])
  }
  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(existsSync(servicesOf(home, 'demo'))).toBe(false)
  await until(() => serverIds(home, 'stop').length === 1)
})

test.concurrent('cmod program --remove-service of a program with no service changes nothing and exits 0, so a second session that removes it too fails nothing, and the other services of the mod stay', async () => {
  const home = await serviceHome()
  const other = { label: 'com.claudemodmanager.demo.other-server', unit: join(home, 'Library/LaunchAgents/com.claudemodmanager.demo.other-server.plist') }
  await writeFiles(home, { '.local/share/cmod/services/demo/other-server.json': `${JSON.stringify(other)}\n` })

  expect(await cmod(home, 'program', 'demo', '--remove-service', '--', 'fake-server')).toEqual({ exitCode: 0, stdout: '', stderr: '' })

  expect(serviceCalls(home)).toEqual([])
  expect(readdirSync(servicesOf(home, 'demo'))).toEqual(['other-server.json'])
})

test.concurrent('a mod whose new version still declares the program keeps its service loaded across cmod setup and the next session start', async () => {
  const home = await serviceHome()
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 1)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  const loaded = serviceCalls(home).length

  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect(await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user start ${label('demo')}.service`])
  expect(existsSync(unitOf(home, 'demo'))).toBe(true)
  expect(readdirSync(servicesOf(home, 'demo')).sort()).toEqual(isMac ? ['fake-server.json', 'fake-server.log'] : ['fake-server.json'])
  expect(serverIds(home, 'stop')).toEqual([])
})

test.concurrent('cmod list shows the programs a mod runs as a service of this computer', async () => {
  const home = await serviceHome()
  const root = await createMod(home)
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, { id: 'demo@market', version: '0.1.0', scope: 'user', enabled: true, installPath: root }]) })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)

  const listed = await cmod(home, 'list')
  const json = await cmod(home, 'list', '--json')

  expect(listed.stdout).toMatch(/\ndemo@market +0\.1\.0 +ready, runs fake-server as a service of this computer\n/)
  expect((JSON.parse(json.stdout) as { name: string }[]).find(({ name }) => name === 'demo@market')).toMatchObject({ services: ['fake-server'] })
})

test.concurrent('cmod program --service where the service manager refuses runs the copy itself, as --no-wait does, and leaves no unit or record', async () => {
  const home = await serviceHome()
  await writeFiles(home, { 'service-refuses': '' })

  const first = startCmod(home, 'program', 'demo', '--service', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  expect(owner(home)).toBe(first.child.pid)
  expect(existsSync(unitOf(home, 'demo'))).toBe(false)
  expect(existsSync(servicesOf(home, 'demo'))).toBe(false)
  first.child.kill()
  expect((await first.done).stderr).toContain('Domain does not support specified action')
})
