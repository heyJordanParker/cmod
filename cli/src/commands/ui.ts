import { stat } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { isObject, serveSocketPath, storeFolder } from '@cmodjs/core/src/records.js'
import { listenMethod, methodName, onMethod, uiEvents, uiInterface, uiParts, type Heard, type Listening } from '@cmodjs/core/src/runtime/interfaces.js'
import { connectServe } from '@cmodjs/core/src/runtime/bun.js'
import { RpcError, rpcCodes, RpcUnreached, type RpcClient, type RpcHandler } from '@cmodjs/core/src/runtime/rpc.js'
import { surfaces, type Surface } from '@cmodjs/core/src/session/session.js'
import { areas, type Area } from '@cmodjs/core/src/ui/areas.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { ifMissing } from '../files.js'

export const summary = "Reach each session's widgets, views, and pages, as an app that draws them does."

export const help = `Usage: cmod ui list <widgets|views|pages> <session>
       cmod ui draw <session> <mod> <id> [--columns <n>] [--surface <surface>] [--area <area>]
       cmod ui press <session> <handler> [<json>]
       cmod ui open <session> <mod> <id>
       cmod ui close <session> <mod> <id>
       cmod ui show <session> <client> [<mod>/<id>...] [--host]
       cmod ui follow [<session>...] [--after <cursor>]

${summary}

Each one reaches the cmod/UI interface through cmod serve, which sends the call
to the cmod plugin of the session it names, and prints the answer as JSON.

list prints the session's widgets, each { mod, id, areas }, or its views or
pages, each { mod, id, title }.

draw prints the widget, view, or page as element data, the shape the cmod
plugin draws, with each handler as { "$cmodHandler": <number> }, or null while
the mod has not drawn it yet. --columns is the width it draws in, 80 unless
given, and --surface is the app that draws it: terminal, the default, desktop,
mobile, vscode, browser, or herdr. --area is the area a widget shows in, one of
the areas it lists: abovePrompt, belowPrompt, working, turnEnd, or dashboard.
Without it, a widget draws for the dashboard when it lists the dashboard, else
for its first area. For turnEnd, it draws the session's last finished turn, and
prints null before the first one finishes.

press runs the handler with that number from one of the session's last two
drawings of the part, with the press <json> gives: { surface, key, kind, value,
link }, whose surface is terminal unless it names one.

open and close show or take away the view or page in the session's Sidebar.

show tells which views and pages one place an app draws in shows, so each one
counts as shown in its mod. <client> names that place, a name the app picks.
Each show replaces that client's last list, and one with no parts clears it.
cmod serve forgets a list 16 seconds after its client's last show, so an app
runs it again before then. --host says the place hosts the session's views, as
a panel beside its terminal does: while one does, the session opens Claude
Code's own Sidebar for no view or page, and tells the place each Open the
person asked for, so the place shows itself. A show with --host and no parts
keeps the host.

follow prints the next batch of Change, Redraw, Open, and Close events of the
sessions named, or of every session, as { cursor, events, missed }, and exits:
at once when events came after the --after cursor, else on the next event,
else after 8 seconds, the time cmod serve answers each poll within. Each event
is { event: "Change", session, part }, { event: "Redraw", session, mod, id }, or
{ event: "Open" or "Close", session, mod, id } for a view or page its mod
opened or closed itself, and an Open the person asked for, with a command, a
hotkey, or a press, carries isAsked: true.
Pass the cursor it printed to --after on the next run, so a loop that runs it
again misses no event. missed is true when the events before the cursor are
unknown: on a run without --after, once cmod serve started again, or once more
events passed than cmod serve keeps. Then read every list and drawing again.`

const followMs = 8000

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { columns: { type: 'string' }, surface: { type: 'string' }, area: { type: 'string' }, after: { type: 'string' }, host: { type: 'boolean', default: false } } })
  const [command, ...named] = positionals
  const answer = await asked(command, named, values)
  process.stdout.write(`${JSON.stringify(answer ?? null)}\n`)
  return 0
}

function asked(command: string | undefined, named: readonly string[], values: { readonly columns?: string | undefined; readonly surface?: string | undefined; readonly area?: string | undefined; readonly after?: string | undefined; readonly host?: boolean | undefined }): Promise<unknown> {
  const [session, mod, id] = named
  if (command === 'list' && named.length === 2 && (uiParts as readonly unknown[]).includes(named[0])) return calledOnServe(named[0] as string, [named[1]])
  if (command === 'draw' && named.length === 3) return calledOnServe('draw', [session, { mod, id }, { columns: columnsOf(values.columns), surface: surfaceOf(values.surface), ...areaOf(values.area) }])
  if (command === 'press' && (named.length === 2 || named.length === 3)) return calledOnServe('press', [session, handlerOf(named[1] as string), pressOf(named[2])])
  if ((command === 'open' || command === 'close') && named.length === 3) return calledOnServe(command, [session, { mod, id }])
  if (command === 'show' && named.length >= 2) return calledOnServe('show', [session, named[1], named.slice(2).map(partOf), ...(values.host === true ? [{ isHost: true }] : [])])
  if (command === 'follow') return follow(named, values.after)
  throw new Error(`cmod ui takes list <widgets|views|pages> <session>, draw <session> <mod> <id>, press <session> <handler> [<json>], open or close <session> <mod> <id>, show <session> <client> [<mod>/<id>...], or follow [<session>...].\n\n${help}`)
}

function calledOnServe(method: string, args: readonly unknown[]): Promise<unknown> {
  return withServe((client) => client.request(methodName(uiInterface, method), args), (called) => Promise.reject(new RpcError(rpcCodes.methodNotFound, `cmod ui answers no ${called}.`)))
}

async function withServe<Answer>(ask: (client: RpcClient) => Promise<Answer>, handle: RpcHandler): Promise<Answer> {
  const socket = serveSocketPath(storeFolder(process.env))
  const client = connectServe({ handle })
  try {
    return await ask(client)
  } catch (error) {
    if (error instanceof RpcUnreached) throw new Error(`cmod ui reaches no cmod serve at ${socket}: ${messageOf(error)}. A Claude Code session with the cmod plugin starts it.`)
    throw error
  } finally {
    await client.close()
  }
}

async function follow(sessions: readonly string[], after: string | undefined): Promise<{ readonly cursor: string; readonly events: readonly object[]; readonly missed: boolean }> {
  const started = String(Math.trunc((await stat(serveSocketPath(storeFolder(process.env))).catch(ifMissing(undefined)))?.mtimeMs ?? 0))
  const given = cursorOf(after)
  const isSameServe = given?.started === started
  const last = new Map(uiEvents.map((event, index) => [event, isSameServe ? (given.counts[index] ?? 0) : 0]))
  const heard: object[] = []
  let missed = !isSameServe
  let wake: () => void = () => undefined
  const woken = new Promise<void>((resolve) => {
    wake = resolve
  })
  const handle: RpcHandler = (method, params) => {
    if (method !== onMethod) throw new RpcError(rpcCodes.methodNotFound, `cmod ui answers no ${method}.`)
    const { id: event, payload, cursor } = params as Heard
    const at = Number(cursor)
    const before = last.get(event) ?? 0
    if (at !== before + 1) missed = true
    last.set(event, Math.max(before, at))
    const told = isObject(payload) ? payload : {}
    if (sessions.length === 0 || sessions.includes(String(told['session']))) heard.push({ event, ...told })
    if (heard.length > 0 || missed) wake()
    return null
  }
  return withServe(async (client) => {
    for (const event of uiEvents) await client.request(listenMethod, { id: event, interface: uiInterface, event, kind: 'on', after: String(last.get(event)) } satisfies Listening)
    if (!missed && heard.length === 0) await within(woken, followMs)
    return { cursor: [started, ...last.values()].join(':'), events: missed ? [] : heard, missed }
  }, handle)
}

async function within(waited: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([waited, new Promise<void>((resolve) => void (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}

function cursorOf(value: string | undefined): { readonly started: string; readonly counts: readonly number[] } | undefined {
  if (value === undefined) return undefined
  const [started, ...given] = value.split(':')
  const counts = given.map(Number)
  if (started === undefined || started === '' || counts.length !== uiEvents.length || counts.some((count) => !Number.isInteger(count) || count < 0)) throw new Error(`--after takes the cursor cmod ui follow printed, such as 1795170983554:12:40:1:0, not ${value}.`)
  return { started, counts }
}

function columnsOf(value: string | undefined): number {
  if (value === undefined) return 80
  const columns = Number(value)
  if (!Number.isInteger(columns) || columns < 1) throw new Error(`--columns takes a whole number above 0, not ${value}.`)
  return columns
}

function surfaceOf(value: string | undefined): Surface {
  if (value === undefined) return 'terminal'
  if (!(surfaces as readonly string[]).includes(value)) throw new Error(`--surface takes ${surfaces.join(', ')}, not ${value}.`)
  return value as Surface
}

function areaOf(value: string | undefined): { readonly area?: Area } {
  if (value === undefined) return {}
  if (!(areas as readonly string[]).includes(value)) throw new Error(`--area takes ${areas.join(', ')}, not ${value}.`)
  return { area: value as Area }
}

function partOf(value: string): { readonly mod: string; readonly id: string } {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error(`cmod ui show takes each part as <mod>/<id>, such as demo/runs, not ${value}.`)
  return { mod: value.slice(0, slash), id: value.slice(slash + 1) }
}

function handlerOf(value: string): number {
  const handler = Number(value)
  if (!Number.isInteger(handler) || handler < 0) throw new Error(`cmod ui press takes a handler number from a drawing, such as 12, not ${value}.`)
  return handler
}

function pressOf(value: string | undefined): object {
  if (value === undefined) return { surface: 'terminal' }
  let press: unknown
  try {
    press = JSON.parse(value)
  } catch (error) {
    throw new Error(`cmod ui press takes the press as JSON, such as {"surface":"herdr","key":"demo/runs:rerun"}: ${messageOf(error)}`)
  }
  if (!isObject(press)) throw new Error(`cmod ui press takes the press as a JSON object, such as {"surface":"herdr","key":"demo/runs:rerun"}, not ${value}.`)
  return { ...press, surface: surfaceOf(typeof press['surface'] === 'string' ? press['surface'] : undefined) }
}
