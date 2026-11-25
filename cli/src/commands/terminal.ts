import type { InterfaceProvider } from '@cmodjs/core/src/mod.js'
import { messageOf } from '@cmodjs/core/src/utils/text.js'
import { withScript } from '../script.js'

export const summary = "Read, type into, or show a session's terminal, through the app that runs it."

export const help = `Usage: cmod terminal screen <session>
       cmod terminal press <session> <keys>
       cmod terminal show <session> [focus|peek|tab|right|down|hide]

${summary}

Each one asks every program that provides cmod/Terminal, such as Herdr, for the
terminal that runs the session, as the person sees it. screen prints the
terminal's screen. press types the keys into it, as the person would, such as
an answer to a dialog: "1\\r" for its first choice and Enter, where \\r is Enter
and \\e is Esc. show shows the
terminal in a pane of the app: focused, the default, as a peek, as a tab, right
of or below the focused pane, or hidden again. A session claude --bg started
has no terminal.`

const places = ['focus', 'peek', 'tab', 'right', 'down', 'hide'] as const

type Terminal = InterfaceProvider<'cmod/Terminal'>

export async function run(argv: string[]): Promise<number> {
  const [command, session, given, ...rest] = argv
  if (session === undefined || rest.length > 0) throw new Error(`cmod terminal takes screen, press, or show, and a session.\n\n${help}`)
  if (command === 'screen' && given === undefined) {
    process.stdout.write(`${await onTerminal(session, (terminal) => terminal.screen(session))}\n`)
    return 0
  }
  if (command === 'press' && given !== undefined) {
    await onTerminal(session, (terminal) => terminal.press(session, given.replaceAll('\\r', '\r').replaceAll('\\n', '\n').replaceAll('\\e', '\u001b')))
    process.stdout.write(`Typed the keys into session ${session}.\n`)
    return 0
  }
  if (command === 'show') {
    const place = places.find((each) => each === (given ?? 'focus'))
    if (place === undefined) throw new Error(`cmod terminal show takes ${places.join(', ')}, not ${String(given)}.`)
    await onTerminal(session, (terminal) => terminal.show(session, place))
    process.stdout.write(place === 'hide' ? `Hid the terminal of session ${session}.\n` : `Showed the terminal of session ${session} (${place}).\n`)
    return 0
  }
  throw new Error(`cmod terminal takes screen <session>, press <session> <keys>, or show <session> [place].\n\n${help}`)
}

function onTerminal<Value>(session: string, run: (terminal: Terminal) => Promise<Value>): Promise<Value> {
  return withScript('terminal', process.cwd(), async (script) => {
    const found = await script.providers('cmod/Terminal')
    const refused: string[] = []
    for (const terminal of found) {
      try {
        return await run(terminal)
      } catch (error) {
        refused.push(`${terminal.mod}: ${messageOf(error)}`)
      }
    }
    throw new Error(found.length === 0 ? `no program on this computer provides cmod/Terminal, so the terminal of session ${session} is out of reach. A session claude --bg started has none.` : `no terminal runs session ${session}. ${refused.join(' ')}`)
  })
}
