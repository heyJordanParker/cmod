import { browserCommand, parseTailnetRecord, parseWebUi, storeFolder, tailnetPath, webPath } from '@cmodjs/core/src/records.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { readJson } from '../files.js'
import { capture } from '../process.js'
import { serve } from './serve.js'

export const summary = 'Run your Claude Code sessions from one page in your browser.'

export const help = `Usage: cmod web
       cmod web serve

${summary}

cmod web opens the browser app at http://127.0.0.1:<port>/ and prints that
address. It works while the browser app runs, which it does once you pressed
open in browser on the Sidebar in Claude Code, and until you turn off "Show
the Sidebar in your browser" in Settings, under cmod, Preferences.

While Tailscale is signed in, the browser app is on your tailnet too, and cmod
web prints that address, https://<computer>.<tailnet>.ts.net:<port>/, which
opens from each of your machines. It answers only you there, by the Tailscale
login of the request, and Settings, under cmod, Preferences, turns it off.

cmod web serve runs cmod serve, the server of this computer's sessions that
serves the browser app, for a session whose cmod plugin is older. cmod serve
--help describes it.`

const answerMs = 2000

export async function run(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv
  if (rest.length > 0 || (mode !== undefined && mode !== 'serve')) throw new Error(`cmod web takes no arguments, or serve.\n\n${help}`)
  return mode === 'serve' ? serve() : open()
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
  const tailnet = tailnetPath(storeFolder(process.env), 'cmod', 'cmod')
  const tailnetUrl = parseTailnetRecord(await readJson(tailnet), tailnet)?.url
  if (tailnetUrl != null) process.stdout.write(`From your other machines: ${tailnetUrl}\n`)
  const { BROWSER: browser, SSH_CONNECTION: sshConnection, DISPLAY: display, WAYLAND_DISPLAY: waylandDisplay } = process.env
  const command = browserCommand({ os: process.platform, browser, sshConnection, display, waylandDisplay }, home)
  if (command === undefined) throw new Error('this computer has no browser to open, so open the address above yourself.')
  const opened = await capture([...command]).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: messageOf(error) }))
  if (opened.exitCode !== 0) throw new Error(`${command[0]} did not open your browser, so open the address above yourself. ${opened.stderr.trim()}`.trim())
  return 0
}
