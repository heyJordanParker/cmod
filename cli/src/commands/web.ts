import { parsePreferences, parseWebUi, preferencesPath, storeFolder, webPath } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { readJson, writeAtomically } from '../files.js'
import { capture } from '../process.js'
import { isNewerCmodInstalled } from '../store.js'
import { serveWeb } from '../web.js'

export const summary = 'Run your Claude Code sessions from one page in your browser.'

export const help = `Usage: cmod web
       cmod web serve

${summary}

cmod web opens the browser app at http://127.0.0.1:<port>/ and prints that
address. It works while the browser app runs, which it does once you pressed
open in browser on the Sidebar in Claude Code, and until you turn off "Show
the Sidebar in your browser" in Settings, under cmod, Preferences.

cmod web serve runs the browser app on 127.0.0.1. It lists every Claude Code
session that runs on this computer, in every project, from Claude Code's own
records and transcripts: the ones that need you, the ones that replied, the
ones working, and the idle ones. A session opens its conversation with a
prompt box under it, which sends the prompt as yours, and the Sidebar pages
its cmod plugin draws. The cmod plugin of each session runs it through cmod
program, so one copy serves every session, while the preference is on. It
keeps web.json in the cmod store with the port it listens on, listens on that
port again while it is free, and prints 127.0.0.1:<port> once it listens. It
keeps which replies you read in web-read.json beside it. It exits once the
preference is off or a newer cmod is installed in the cmod store, and a copy
started while the preference is off waits until it is on.`

const checkMs = 5000

const answerMs = 2000

export async function run(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv
  if (rest.length > 0 || (mode !== undefined && mode !== 'serve')) throw new Error(`cmod web takes no arguments, or serve.\n\n${help}`)
  return mode === 'serve' ? serve() : open()
}

async function isOn(store: string): Promise<boolean> {
  return parsePreferences(await readJson(preferencesPath(store)), preferencesPath(store)).servesWebUi
}

async function serve(): Promise<number> {
  const store = storeFolder(process.env)
  while (!(await isOn(store))) {
    if (await isNewerCmodInstalled()) return 0
    await Bun.sleep(checkMs)
  }
  const path = webPath(store)
  const server = serveWeb({ port: parseWebUi(await readJson(path), path)?.port ?? 0 })
  try {
    await writeAtomically(path, `${JSON.stringify({ port: server.port }, null, 2)}\n`)
    process.stdout.write(`127.0.0.1:${server.port}\n`)
    while ((await isOn(store)) && !(await isNewerCmodInstalled())) await Bun.sleep(checkMs)
    return 0
  } finally {
    await server.stop()
  }
}

async function open(): Promise<number> {
  const path = webPath(storeFolder(process.env))
  const saved = parseWebUi(await readJson(path), path)
  const home = `http://127.0.0.1:${saved?.port ?? 0}/`
  const unanswered = (error: unknown) => {
    if (error instanceof Error) return undefined
    throw error
  }
  const page = saved === undefined ? undefined : await fetch(home, { signal: AbortSignal.timeout(answerMs) }).catch(unanswered)
  if (page?.ok !== true) throw new Error('the browser app does not run now. Press open in browser on the Sidebar in Claude Code, which turns it on.')
  process.stdout.write(`${home}\n`)
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const opened = await capture([opener, home]).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: messageOf(error) }))
  if (opened.exitCode !== 0) throw new Error(`${opener} did not open your browser, so open the address above yourself. ${opened.stderr.trim()}`.trim())
  return 0
}
