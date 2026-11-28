import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { listenMethod, storeInterface } from '@cmodjs/core/src/runtime/interfaces.js'
import { dataFolder, parsePreferences, parseServeApps, parseTailnetRecord, parseWebUi, preferencesPath, serveAppsPath, serveSocketPath, storeFolder, tailnetPath, webPath, type ServeApps } from '@cmodjs/core/src/records.js'
import { rpcPath } from '@cmodjs/core/src/runtime/rpc.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { ifMissing, readJson, writeAtomically } from '../files.js'
import { placeHerdrMod } from '../herdr.js'
import { openIndex, runningEntries } from '../history.js'
import { answered, answeredOlderPlugin, newServeToken, serveApps, serveSessions } from '../serve.js'
import { isNewerCmodInstalled, readSecret, storeSecret } from '../store.js'
import { readTailnet, serveOnTailnet, stopServing, tailnetEnvironment } from '../tailnet.js'
import { webApp } from '../web.js'

const apiProgram = 'api'

export const summary = "Serve this computer's sessions to every session, script, and the browser app."

export const help = `Usage: cmod serve
       cmod serve status [--json]

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
over a WebSocket on 127.0.0.1 at /ui, or posts one JSON-RPC 2.0 request or a
batch to /rpc there and reads the answers in the response. Its address and the
token are in serve.json in the cmod store, which only you can read, and a
request without the token, as Authorization: Bearer <token> or ?token=<token>,
is refused. cmod makes the token once and keeps it among cmod's secrets.

While "Let agents on your tailnet reach your sessions" and "Open web apps from
your other devices, through Tailscale" are on in Settings, under cmod,
Preferences, Tailscale serves the same /rpc and /ui at
https://<computer>.<tailnet>.ts.net:<port>/, with the same token, so an agent
on another device lists, reads, messages, and starts this computer's sessions
with the methods cmod/Sessions names, such as:

  curl -H "Authorization: Bearer $TOKEN" -d '{"jsonrpc":"2.0","id":1,
    "method":"cmod/Sessions.sessions","params":[{"running":true}]}' \\
    https://<computer>.<tailnet>.ts.net:<port>/rpc

cmod serve status prints each address cmod serve answers at, and the token.

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
  if (argv[0] === 'status') return printStatus(argv.slice(1))
  if (argv.length > 0) throw new Error(`cmod serve takes no arguments but status.\n\n${help}`)
  return serve()
}

const tokenKey = 'serveToken'

async function serveToken(): Promise<string> {
  const kept = await readSecret('cmod', tokenKey)
  if (kept !== undefined) return kept
  const made = newServeToken()
  await storeSecret('cmod', tokenKey, made)
  return made
}

async function printStatus(argv: readonly string[]): Promise<number> {
  const isJson = argv.includes('--json')
  const unknown = argv.filter((each) => each !== '--json')
  if (unknown.length > 0) throw new Error(`cmod serve status takes only --json, not ${unknown.join(' ')}.`)
  const store = storeFolder(process.env)
  const path = serveAppsPath(store)
  const apps = parseServeApps(await readJson(path), path)
  if (apps === undefined) throw new Error(`cmod serve is not running: ${path} does not exist. A Claude Code session with the cmod plugin starts it.`)
  const socket = `unix:${serveSocketPath(store)}`
  const tailnet = parseTailnetRecord(await readJson(tailnetPath(store, 'cmod', apiProgram)), tailnetPath(store, 'cmod', apiProgram))
  const api = apps.api === undefined ? undefined : `${apps.api.replace(/\/+$/, '')}${rpcPath}`
  if (isJson) {
    process.stdout.write(`${JSON.stringify({ socket, apps: apps.url, ...(api === undefined ? {} : { api }), token: apps.token }, null, 2)}\n`)
    return 0
  }
  const lines = [
    `sessions and scripts here  ${socket}`,
    `apps here                  ${apps.url}`,
    `agents on your tailnet     ${api ?? `off: ${tailnet?.reason ?? 'Off in Settings, under cmod, Preferences.'}`}`,
    `token                      ${apps.token}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
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
  const apps = serveApps(sessions.routes, await serveToken(), report)
  let api: string | undefined
  const served = { isApiOn: false }
  const writeApps = () => writeAtomically(serveAppsPath(store), `${JSON.stringify({ url: apps.url, token: apps.token, ...(api === undefined ? {} : { api }) } satisfies ServeApps, null, 2)}\n`, { mode: 0o600 })
  await writeApps()
  const ending = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => ending.abort())
  let page: number | undefined
  let checking = Promise.resolve()
  const check = () =>
    void (checking = checking.then(async () => {
      if (ending.signal.aborted) return
      if (await isNewerCmodInstalled()) return ending.abort()
      const preferences = parsePreferences(await readJson(preferencesPath(store)), preferencesPath(store))
      const isApiWanted = preferences.servesApi && preferences.servesTailnet
      if (isApiWanted && !served.isApiOn) {
        api = await serveOnTailnet(await readTailnet().catch((error: unknown) => ({ reason: messageOf(error) })), 'cmod', apiProgram, `127.0.0.1:${new URL(apps.url).port}`)
        served.isApiOn = true
        await writeApps()
        if (api !== undefined) process.stderr.write(`cmod serve: serves its API to your tailnet at ${api}\n`)
      }
      if (!isApiWanted && served.isApiOn) {
        served.isApiOn = false
        api = undefined
        await stopServing('cmod', apiProgram)
        await writeApps()
        process.stderr.write('cmod serve: took its API off your tailnet, because it is off in Settings\n')
      }
      const isOn = preferences.servesWebUi
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
    if (served.isApiOn) await stopServing('cmod', apiProgram).catch((error: unknown) => report('kept its API on your tailnet', error))
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
