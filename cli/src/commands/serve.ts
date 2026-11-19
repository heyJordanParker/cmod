import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataFolder, parsePreferences, parseWebUi, preferencesPath, serveSocketPath, storeFolder, webPath } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { ifMissing, readJson, writeAtomically } from '../files.js'
import { openHistory, runningEntries } from '../history.js'
import { answered, serveSessions } from '../serve.js'
import { readTailnet, serveOnTailnet, stopServing, tailnetEnvironment } from '../tailnet.js'
import { webApp } from '../web.js'

export const summary = "Serve this computer's sessions to every session, script, and the browser app."

export const help = `Usage: cmod serve

${summary}

cmod serve is the one server of this computer's Claude Code sessions. The cmod
plugin runs it as a service of the computer, com.claudemodmanager.cmod.cmod, of
launchd's Interactive class on macOS, because every session waits on it. It
listens on serve.sock in the cmod store, which only you can open, and prints
unix:<socket> once it listens.

On that socket it serves the cmod/SessionStore interface, the reads cmod history
answers, from the conversation index it keeps open, and the cmod/Session
interface. Each session's cmod plugin holds one connection to it and names the
session it holds, so a call on a session, such as a message, reaches the
session that runs it, and a before or on listener on a session is held on the
connection of the session or script that listens, until it closes. A message
to a session that has ended resumes it in the background. It keeps when each
session was last opened in visited.json in the cmod store. At its start it
deletes each file of the cmod plugin's before folder, where a cmod plugin from
before 7.0.0 kept its session's before listeners, whose session no longer runs,
and moves the replies cmod web serve before 7.0.0 marked read, web-read.json, to
visited.json.

While "Show the Sidebar in your browser" is on in Settings, under cmod,
Preferences, it serves the browser app on 127.0.0.1 at the port web.json keeps,
and on your tailnet while Tailscale is signed in, as cmod web describes. cmod web
serve runs the same server, for a session whose cmod plugin is older.`

const checkMs = 5000

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
  const db = openHistory()
  const sessions = serveSessions({ db, report })
  const web = webApp({ db, sessions })
  await mkdir(dirname(socket), { recursive: true })
  await rm(socket, { force: true })
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      return answered(sessions.routes, request) ?? web.sessionRoute(request) ?? Response.json({ error: `cmod serve has no ${request.method} ${new URL(request.url).pathname}.` }, { status: 404 })
    },
  })
  await chmod(socket, 0o600)
  const ending = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => ending.abort())
  process.stdout.write(`unix:${socket}\n`)
  let page: number | undefined
  try {
    while (!ending.signal.aborted) {
      const isOn = parsePreferences(await readJson(preferencesPath(store)), preferencesPath(store)).servesWebUi
      if (isOn && page === undefined) page = await openPage(web, store, report)
      if (!isOn && page !== undefined) {
        page = undefined
        await web.close()
        await stopServing('cmod', 'cmod').catch((error: unknown) => report('kept the browser app on your tailnet', error))
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, checkMs)
        ending.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    return 0
  } finally {
    await web.stop()
    if (page !== undefined) await stopServing('cmod', 'cmod').catch((error: unknown) => report('kept the browser app on your tailnet', error))
    sessions.close()
    await server.stop(true)
    await rm(socket, { force: true })
    db.close()
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
