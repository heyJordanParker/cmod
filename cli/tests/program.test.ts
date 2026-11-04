import { afterAll, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAnswering, cmod, cmodFromSource, cmodPluginListed, cmodWith, createMod, deleteTemporaryHomes, environment, startCmod, temporaryHome, writeFiles } from './cmod.js'

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

const instances = (home: string) => join(home, '.local/share/cmod/instances/tools')

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

async function until(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('waited 20 seconds')
    await Bun.sleep(100)
  }
}

test.concurrent('two cmod program processes started together run one copy, and both print its address', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  const second = startCmod(home, 'program', 'tools', '--', 'fake-server')
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
}, 60000)

test.concurrent("SIGTERM to the owner stops its copy, and the waiter starts the next copy and prints that copy's address", async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const second = startCmod(home, 'program', 'tools', '--', 'fake-server')
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
}, 60000)

test.concurrent('cmod program --no-wait with no holder runs the copy and prints its address', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--no-wait', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  expect(owner(home)).toBe(first.child.pid)
  first.child.kill()
  await first.done
}, 60000)

test.concurrent("cmod program --no-wait beside a holder touches the holder's lock file, prints held, and exits 0 without a second copy", async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')
  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  const holder = join(instances(home), 'fake-server.json.lock', String(first.child.pid))
  utimesSync(holder, new Date(0), new Date(0))

  const { exitCode, stdout } = await cmod(home, 'program', 'tools', '--no-wait', '--', 'fake-server')

  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('held')
  expect(Date.now() - statSync(holder).mtimeMs).toBeLessThan(5000)
  expect(serverIds(home, 'start')).toEqual([copy as string])
  first.child.kill()
  await first.done
}, 60000)

test.concurrent('the holder touches its file in the lock every 5 seconds', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const holder = join(instances(home), 'fake-server.json.lock', String(first.child.pid))
  utimesSync(holder, new Date(0), new Date(0))

  await until(() => statSync(holder).mtimeMs > 0)

  expect(Date.now() - statSync(holder).mtimeMs).toBeLessThan(5000)
  first.child.kill()
  await first.done
}, 60000)

test.concurrent('after the owner is killed with SIGKILL, the next owner stops the orphaned copy before it starts its own', async () => {
  const home = await serverHome()
  const first = startCmod(home, 'program', 'tools', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const second = startCmod(home, 'program', 'tools', '--', 'fake-server')
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
}, 60000)

test.concurrent('the owner stops its copy and gives up the election when its parent process dies', async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodFromSource })
  const parent = Bun.spawn(['sh', '-c', 'cmod program tools -- fake-server & wait'], { cwd: home, env: environment(home), stdout: 'ignore', stderr: 'ignore' })
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  parent.kill('SIGKILL')
  await until(() => serverIds(home, 'stop').length === 1)

  expect(serverLog(home)).toEqual([`start ${copy}`, `stop ${copy}`])
  await until(() => !existsSync(join(instances(home), 'fake-server.json.lock')))
  expect(existsSync(join(instances(home), 'fake-server.json'))).toBe(false)
}, 60000)

test.concurrent("SIGTERM stops the owner's copy even after the session's working folder is deleted", async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodFromSource, 'project/.keep': '' })
  const first = Bun.spawn([join(home, 'bin/cmod'), 'program', 'tools', '--', 'fake-server'], { cwd: join(home, 'project'), env: environment(home), stdout: 'ignore', stderr: 'ignore' })
  await until(() => serverIds(home, 'start').length === 1)
  await rm(join(home, 'project'), { recursive: true })

  first.kill('SIGTERM')

  expect(await first.exited).toBe(0)
  expect(serverIds(home, 'stop')).toEqual(serverIds(home, 'start'))
}, 60000)

test.concurrent('the copy runs without CLAUDE_CODE_SESSION_ID, because it serves every session', async () => {
  const home = await serverHome()
  await writeFiles(home, { 'bin/session-server': '#!/bin/sh\necho "session ${CLAUDE_CODE_SESSION_ID:-none}" >> "$HOME/server-log"\necho "unix:$HOME/$$.sock"\n' })

  const { exitCode } = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'session-1' }, 'program', 'tools', '--', 'session-server')

  expect(exitCode).toBe(0)
  expect(serverLog(home)).toEqual(['session none'])
}, 60000)

test.concurrent("cmod teardown deletes the removed mod's instances folder and keeps another mod's", async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.local/share/cmod/instances/tools/fake-server.json': '{}\n', '.local/share/cmod/instances/notes/fake-server.json': '{}\n' })

  const result = await cmod(home, 'teardown', 'tools', '--events')

  expect(result.exitCode).toBe(0)
  expect(existsSync(instances(home))).toBe(false)
  expect(existsSync(join(home, '.local/share/cmod/instances/notes/fake-server.json'))).toBe(true)
}, 60000)

test.concurrent("a copy that crashes makes the owner exit with the copy's exit code and pass its standard error through", async () => {
  const home = await serverHome()

  const { exitCode, stderr } = await cmod(home, 'program', 'tools', '--', 'crash-server')

  expect(exitCode).toBe(3)
  expect(stderr).toContain('no port is free')
  expect(existsSync(join(instances(home), 'crash-server.json.lock'))).toBe(false)
}, 60000)

const uid = process.getuid?.() ?? 0

const isMac = process.platform === 'darwin'

const label = (mod: string) => `com.claudemodmanager.${mod}.fake-server`

const unitOf = (home: string, mod: string) => (isMac ? join(home, 'Library/LaunchAgents', `${label(mod)}.plist`) : join(home, '.config/systemd/user', `${label(mod)}.service`))

const servicesOf = (home: string, mod: string) => join(home, '.local/share/cmod/services', mod)

function serviceCalls(home: string): string[] {
  return existsSync(join(home, 'service-calls')) ? readFileSync(join(home, 'service-calls'), 'utf8').trim().split('\n') : []
}

async function serviceHome(mod: string): Promise<string> {
  const home = await serverHome()
  await writeFiles(home, { 'bin/cmod': cmodFromSource, 'start-service.sh': `#!/bin/sh\n"$HOME/bin/cmod" program ${mod} -- fake-server\n` })
  return home
}

async function stopService(home: string, mod: string): Promise<void> {
  await until(() => serverIds(home, 'start').length > 0)
  process.kill(Number(readdirSync(join(home, '.local/share/cmod/instances', mod, 'fake-server.json.lock'))[0]), 'SIGTERM')
  await until(() => serverIds(home, 'stop').length === serverIds(home, 'start').length)
}

test.concurrent("cmod program --service writes a launchd agent on macOS and a systemd user service on Linux that runs cmod program with the program's command, home, and a restart on every exit, loads it, and prints held once the service holds the lock", async () => {
  const home = await serviceHome('tools')
  const path = `${join(home, '.local/share/cmod/programs')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const cmodProgram = join(home, '.local/share/cmod/programs/cmod')

  const { exitCode, stdout } = await cmodWith(home, { TOOLS_DEVICE: 'mac-1' }, 'program', 'tools', '--service', '--env', 'TOOLS_DEVICE', '--', 'fake-server', '--port', '0')

  expect([exitCode, stdout]).toEqual([0, 'held\n'])
  if (isMac) {
    expect(readFileSync(unitOf(home, 'tools'), 'utf8')).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudemodmanager.tools.fake-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cmodProgram}</string>
    <string>program</string>
    <string>tools</string>
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
    <key>TOOLS_DEVICE</key>
    <string>mac-1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`)
    expect(serviceCalls(home)).toEqual([`launchctl print gui/${uid}/${label('tools')}`, `launchctl bootstrap gui/${uid} ${unitOf(home, 'tools')}`])
  } else {
    expect(readFileSync(unitOf(home, 'tools'), 'utf8')).toBe(`[Unit]
Description=fake-server of the tools mod, which cmod runs

[Service]
ExecStart="${cmodProgram}" "program" "tools" "--" "fake-server" "--port" "0"
Environment="HOME=${home}"
Environment="PATH=${path}"
Environment="TOOLS_DEVICE=mac-1"
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`)
    expect(serviceCalls(home)).toEqual(['systemctl --user daemon-reload', `systemctl --user enable ${label('tools')}.service`, `systemctl --user restart ${label('tools')}.service`])
  }
  expect(statSync(unitOf(home, 'tools')).mode & 0o777).toBe(0o600)
  await stopService(home, 'tools')
}, 60000)

test.concurrent('a second cmod program --service of the same mod and program, from a session with another PATH, loads nothing again and runs no second copy', async () => {
  const home = await serviceHome('tools')
  expect(await cmod(home, 'program', 'tools', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const loaded = serviceCalls(home).length

  expect(await cmodWith(home, { PATH: `${join(home, 'bin')}:${join(home, 'project/.venv/bin')}:${process.env['PATH']}` }, 'program', 'tools', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  await Bun.sleep(1000)
  expect(serverIds(home, 'start')).toHaveLength(1)
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl print gui/${uid}/${label('tools')}`] : [`systemctl --user start ${label('tools')}.service`])
  await stopService(home, 'tools')
}, 60000)

test.concurrent("a cmod program --service whose environment changed rewrites the service and loads it again once the service manager let the old one go", async () => {
  const home = await serviceHome('tools')
  expect(await cmodWith(home, { TOOLS_DEVICE: 'mac-1' }, 'program', 'tools', '--service', '--env', 'TOOLS_DEVICE', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })
  const loaded = serviceCalls(home).length

  const changed = await cmodWith(home, { TOOLS_DEVICE: 'mac-2' }, 'program', 'tools', '--service', '--env', 'TOOLS_DEVICE', '--', 'fake-server')

  expect(changed).toMatchObject({ exitCode: 0, stdout: 'held\n', stderr: '' })
  expect(readFileSync(unitOf(home, 'tools'), 'utf8')).toContain('mac-2')
  const calls = serviceCalls(home).slice(loaded)
  if (isMac) {
    expect(calls.slice(0, 2)).toEqual([`launchctl print gui/${uid}/${label('tools')}`, `launchctl bootout gui/${uid}/${label('tools')}`])
    expect(calls.slice(2, -1).every((call) => call === `launchctl print gui/${uid}/${label('tools')}`)).toBe(true)
    expect(calls.at(-1)).toBe(`launchctl bootstrap gui/${uid} ${unitOf(home, 'tools')}`)
  } else {
    expect(calls).toEqual(['systemctl --user daemon-reload', `systemctl --user enable ${label('tools')}.service`, `systemctl --user restart ${label('tools')}.service`])
  }
  await stopService(home, 'tools')
}, 60000)

test.concurrent('cmod setup of a new version of a mod restarts its service, so the service runs the new program', async () => {
  const home = await serviceHome('demo')
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  const loaded = serviceCalls(home).length

  const { exitCode, stdout } = await cmod(home, 'setup', root, '--events')

  expect(exitCode).toBe(0)
  expect(stdout).toContain('log Restarted the fake-server service of demo on 0.2.0\n')
  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl kickstart -k gui/${uid}/${label('demo')}`] : [`systemctl --user restart ${label('demo')}.service`])
  await stopService(home, 'demo')
}, 60000)

test.concurrent('cmod remove stops the service of the mod and deletes its unit and its record', async () => {
  const home = await serviceHome('demo')
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
}, 60000)

test.concurrent("cmod program --remove-service, which the first session of a mod's version without the program runs after cmod setup, stops the service and deletes its unit and its record", async () => {
  const home = await serviceHome('demo')
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
}, 60000)

test.concurrent('cmod program --remove-service of a program with no service changes nothing and exits 0, so a second session that removes it too fails nothing, and the other services of the mod stay', async () => {
  const home = await serviceHome('demo')
  const other = { label: 'com.claudemodmanager.demo.other-server', unit: join(home, 'Library/LaunchAgents/com.claudemodmanager.demo.other-server.plist') }
  await writeFiles(home, { '.local/share/cmod/services/demo/other-server.json': `${JSON.stringify(other)}\n` })

  expect(await cmod(home, 'program', 'demo', '--remove-service', '--', 'fake-server')).toEqual({ exitCode: 0, stdout: '', stderr: '' })

  expect(serviceCalls(home)).toEqual([])
  expect(readdirSync(servicesOf(home, 'demo'))).toEqual(['other-server.json'])
}, 60000)

test.concurrent('a mod whose new version still declares the program keeps its service loaded across cmod setup and the next session start', async () => {
  const home = await serviceHome('demo')
  const root = await createMod(home)
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)
  await until(() => serverIds(home, 'start').length === 1)
  await writeFiles(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '0.2.0' }) })
  const loaded = serviceCalls(home).length

  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect(await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).toMatchObject({ exitCode: 0, stdout: 'held\n' })

  expect(serviceCalls(home).slice(loaded)).toEqual(isMac ? [`launchctl kickstart -k gui/${uid}/${label('demo')}`, `launchctl print gui/${uid}/${label('demo')}`] : [`systemctl --user restart ${label('demo')}.service`, `systemctl --user start ${label('demo')}.service`])
  expect(existsSync(unitOf(home, 'demo'))).toBe(true)
  expect(readdirSync(servicesOf(home, 'demo'))).toEqual(['fake-server.json'])
  expect(serverIds(home, 'stop')).toEqual([])
  await stopService(home, 'demo')
}, 60000)

test.concurrent('cmod list shows the programs a mod runs as a service of this computer', async () => {
  const home = await serviceHome('demo')
  const root = await createMod(home)
  await writeFiles(home, { 'bin/claude': claudeAnswering([...cmodPluginListed, { id: 'demo@market', version: '0.1.0', scope: 'user', enabled: true, installPath: root }]) })
  expect((await cmod(home, 'setup', root, '--events')).exitCode).toBe(0)
  expect((await cmod(home, 'program', 'demo', '--service', '--', 'fake-server')).exitCode).toBe(0)

  const listed = await cmod(home, 'list')
  const json = await cmod(home, 'list', '--json')

  expect(listed.stdout).toMatch(/\ndemo@market +0\.1\.0 +ready, runs fake-server as a service of this computer\n/)
  expect((JSON.parse(json.stdout) as { name: string }[]).find(({ name }) => name === 'demo@market')).toMatchObject({ services: ['fake-server'] })
  await stopService(home, 'demo')
}, 60000)

test.concurrent('cmod program --service where the service manager refuses runs the copy itself, as --no-wait does, and leaves no unit or record', async () => {
  const home = await serviceHome('tools')
  await writeFiles(home, { 'service-refuses': '' })

  const first = startCmod(home, 'program', 'tools', '--service', '--', 'fake-server')
  await until(() => serverIds(home, 'start').length === 1)
  const [copy] = serverIds(home, 'start')

  await first.waitForOutput(`unix:${home}/${copy}.sock`)
  expect(owner(home)).toBe(first.child.pid)
  expect(existsSync(unitOf(home, 'tools'))).toBe(false)
  expect(existsSync(servicesOf(home, 'tools'))).toBe(false)
  first.child.kill()
  expect((await first.done).stderr).toContain('Domain does not support specified action')
}, 60000)
