import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { listenMethod, storeInterface } from '@cmodjs/core/src/runtime/interfaces.js'
import { dataFolder, parsePreferences, parseWebUi, preferencesPath, serveAppsPath, serveSocketPath, storeFolder, webPath, type ServeApps } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { ifMissing, readJson, writeAtomically } from '../files.js'
import { placeHerdrMod } from '../herdr.js'
import { openIndex, runningEntries } from '../history.js'
import { answered, answeredOlderPlugin, serveApps, serveSessions } from '../serve.js'
import { isNewerCmodInstalled } from '../store.js'
import { readTailnet, serveOnTailnet, stopServing, tailnetEnvironment } from '../tailnet.js'
import { webApp } from '../web.js'

export const summary = "Serve this computer's sessions to every session, script, and the browser app."

export const help = `Usage: cmod serve

${summary}

cmod serve is the one server of this computer's Claude Code sessions. The cmod
plugin runs it as a service of the computer, com.claudemodmanager.cmod.cmod, of
launchd's Interactive class on macOS, because every session waits on it. It
listens on serve.sock in the cmod store, which only you can open, and prints
unix:<socket> once it listens. It exits 0 once it finds a newer cmod in the
cmod store, at its start and each time cmod/Store tells that the plugins
changed, so its service starts the newer one.

On that socket it serves the cmod/Sessions interface: the reads cmod sessions
answers, from the conversation index it keeps open, the actions on a session,
and a Change event for each session that starts or stops running, is visited,
or changes its tasks, goal, or status. It lists each running session's status
from Claude Code's record of it and from what the session's cmod plugin hears:
whether a turn runs, what a dialog waits on, how full its context is, and how
its last turn ended. Each session's cmod plugin holds one connection
to it and names the session it holds, so a call on a session, such as a
message, reaches the session that runs it. A message to a session that has
ended resumes it in the background. It keeps when each
session was last opened in visited.json in the cmod store.

It also holds every interface a program on this computer provides through
connect() from @cmodjs/core/rpc.js, and carries each call and listener from a
session or script to the connection that provides it. A program's providers
end with its connection. A program from a 7.0.0 core, which names its
interfaces as provides in its instance file, it reaches at that file's address.
It connects to the cmod serve of each device a cmod/Devices provider names, at
the address the provider gives, or over the messages the provider carries with
its send and Message, lists that device's providers, and carries
each call and listener on one of them there. It offers another device only
this computer's providers, and starts a background task whose device names
this computer. At its start it
deletes each file of the cmod plugin's before folder, where a cmod plugin from
before 7.0.0 kept its session's before listeners, whose session no longer runs,
and moves the replies cmod web serve before 7.0.0 marked read, web-read.json, to
visited.json.

An app that is no session, such as cmod's Herdr mod, reaches the same calls
over a WebSocket on 127.0.0.1 at /ui. Its address and a token made at each
start are in serve.json in the cmod store, which only you can read, and a
connection without ?token=<token> is refused.

At its start it also places cmod's Herdr mod, which draws every session's
widgets, views, and pages in Herdr over that WebSocket, in mods/cmod of Herdr's
home: $HERDR_APP_HOME, else $XDG_CONFIG_HOME/herdr-app, else
~/.config/herdr-app, when that folder exists. It writes only a file that
differs, records each file it wrote in herdr.json in the cmod store, and leaves
a mods/cmod folder it did not write. cmod teardown cmod deletes what it wrote.

While "Show the Sidebar in your browser" is on in Settings, under cmod,
Preferences, it serves the browser app on 127.0.0.1 at the port web.json keeps,
and on your tailnet while Tailscale is signed in, as cmod web describes. cmod web
serve runs the same server, for a session whose cmod plugin is older.`

export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) throw new Error(`cmod serve takes no arguments.\n\n${help}`)
  return serve()
}

export async function serve(): Promise<number> {
  const store = storeFolder(process.env)
  const socket = serveSocketPath(store)
  const report = (doing: string, error: unknown) => process.stderr.write(`cmod serve: ${doing}: ${messageOf(error)}\n`)
  await forgetEndedBefores(store)
  await keepReadMarks(store)
  await placeHerdrMod().catch((error: unknown) => report('placed no Herdr mod', error))
  const index = openIndex()
  const sessions = serveSessions({ index, report })
  const web = webApp({ sessions })
  await mkdir(dirname(socket), { recursive: true })
  await rm(socket, { force: true })
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      return answered(sessions.routes, request) ?? answeredOlderPlugin(request) ?? Response.json({ error: `cmod serve has no ${request.method} ${new URL(request.url).pathname}.` }, { status: 404 })
    },
  })
  await chmod(socket, 0o600)
  const apps = serveApps(sessions.routes, report)
  await writeAtomically(serveAppsPath(store), `${JSON.stringify({ url: apps.url, token: apps.token } satisfies ServeApps, null, 2)}\n`, { mode: 0o600 })
  const ending = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => ending.abort())
  let page: number | undefined
  let checking = Promise.resolve()
  const check = () =>
    void (checking = checking.then(async () => {
      if (ending.signal.aborted) return
      if (await isNewerCmodInstalled()) return ending.abort()
      const isOn = parsePreferences(await readJson(preferencesPath(store)), preferencesPath(store)).servesWebUi
      if (isOn && page === undefined) {
        page = await openPage(web, store, report)
        process.stderr.write(`cmod serve: serves the browser app at http://127.0.0.1:${page}/\n`)
      }
      if (!isOn && page !== undefined) {
        page = undefined
        await web.close()
        await stopServing('cmod', 'cmod').catch((error: unknown) => report('kept the browser app on your tailnet', error))
        process.stderr.write('cmod serve: closed the browser app, because it is off in Settings\n')
      }
    }).catch((error: unknown) => void report('kept the browser app as it was', error)))
  const own = { request: () => Promise.reject(new Error('cmod serve hears its own cmod/Store and answers no request.')), notify: check }
  await sessions.interfaces.handler(own)(listenMethod, { id: 'serve', interface: storeInterface, event: 'Change', kind: 'on', matcher: { part: ['preferences', 'plugins'] } }, ending.signal)
  check()
  process.stdout.write(`unix:${socket}\n`)
  try {
    await new Promise<void>((resolve) => ending.signal.addEventListener('abort', () => resolve(), { once: true }))
    await checking
    return 0
  } finally {
    sessions.interfaces.closed(own)
    await web.stop()
    if (page !== undefined) await stopServing('cmod', 'cmod').catch((error: unknown) => report('kept the browser app on your tailnet', error))
    sessions.close()
    await server.stop(true)
    await apps.stop()
    await rm(socket, { force: true })
    await rm(serveAppsPath(store), { force: true })
    await index.close()
  }
}

async function openPage(web: ReturnType<typeof webApp>, store: string, report: (doing: string, error: unknown) => void): Promise<number> {
  const path = webPath(store)
  const tailnet = await readTailnet().catch((error: unknown) => ({ reason: messageOf(error) }))
  Object.assign(process.env, tailnetEnvironment(tailnet))
  const port = web.listen(parseWebUi(await readJson(path), path)?.port ?? 0)
  await writeAtomically(path, `${JSON.stringify({ port }, null, 2)}\n`)
  await serveOnTailnet(tailnet, 'cmod', 'cmod', `127.0.0.1:${port}`).catch((error: unknown) => report('serves the browser app on 127.0.0.1 alone', error))
  return port
}

async function forgetEndedBefores(store: string): Promise<void> {
  const folder = join(dataFolder(store, 'cmod'), 'before')
  const running = new Set(runningEntries().map((entry) => entry.session))
  const files = await readdir(folder).catch(ifMissing([]))
  for (const name of files) if (!running.has(name.replace(/\.json$/, ''))) await rm(join(folder, name), { force: true })
  if (files.length > 0) await rmdir(folder).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  })
}

async function keepReadMarks(store: string): Promise<void> {
  const marks = join(store, 'web-read.json')
  if (existsSync(join(store, 'visited.json'))) await rm(marks, { force: true })
  else await rename(marks, join(store, 'visited.json')).catch(ifMissing(undefined))
}
