import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { cmod, deleteTemporaryHomes, startCmodWith, temporaryHome, writeFiles } from './cmod.js'

afterAll(deleteTemporaryHomes)

const source = join(import.meta.dir, '..', '..', 'herdr', 'cmod')

const hashOf = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function serveOnce(home: string, env: Record<string, string> = {}) {
  const serving = startCmodWith(home, env, 'serve')
  await serving.firstLine()
  serving.child.kill()
  return (await serving.done).stderr
}

test.concurrent("cmod serve places the Herdr mod in Herdr's home, asking Herdr for no dock and opening the dock as a window with mod.open, records it, and changes nothing when the files are current", async () => {
  const home = await temporaryHome()
  const herdrHome = join(home, 'herdr-home')
  const folder = join(herdrHome, 'mods', 'cmod')
  await mkdir(herdrHome)

  await serveOnce(home, { HERDR_APP_HOME: herdrHome })
  const placed = await stat(join(folder, 'main.js'))
  const again = await serveOnce(home, { HERDR_APP_HOME: herdrHome })
  const kept = await stat(join(folder, 'main.js'))

  const main = await readFile(join(source, 'main.js'), 'utf8')
  const modJson = await readFile(join(folder, 'mod.json'), 'utf8')
  expect(await readFile(join(folder, 'main.js'), 'utf8')).toBe(main)
  expect(JSON.parse(modJson)).toEqual({ place: 'none', overlay: { kind: 'window', key: 'cmod', width: 360, height: 600, props: { show: 'views' } } })
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/herdr.json'), 'utf8'))).toEqual({ [folder]: { 'main.js': hashOf(main), 'mod.json': hashOf(modJson) } })
  expect([kept.ino, kept.mtimeMs, again.includes('Herdr')]).toEqual([placed.ino, placed.mtimeMs, false])
}, 30_000)

test.concurrent('cmod serve places nothing when Herdr has no home on the computer', async () => {
  const home = await temporaryHome()

  await serveOnce(home)

  expect([existsSync(join(home, '.config', 'herdr-app')), existsSync(join(home, '.local/share/cmod/herdr.json'))]).toEqual([false, false])
}, 30_000)

test.concurrent("cmod serve leaves a person's own mods/cmod folder in Herdr's home, and says so", async () => {
  const home = await temporaryHome()
  await writeFiles(home, { '.config/herdr-app/mods/cmod/main.js': 'export default class Mine {}\n' })

  const said = await serveOnce(home)

  expect(await readFile(join(home, '.config/herdr-app/mods/cmod/main.js'), 'utf8')).toBe('export default class Mine {}\n')
  expect(existsSync(join(home, '.config/herdr-app/mods/cmod/mod.json'))).toBe(false)
  expect(said).toContain(`cmod serve: placed no Herdr mod: ${join(home, '.config/herdr-app/mods/cmod/main.js')} is not the cmod Herdr mod cmod placed, so cmod leaves it and places no Herdr mod.`)
}, 30_000)

test.concurrent('cmod teardown cmod deletes the Herdr mod cmod serve placed, with the files Herdr and the mod wrote beside it', async () => {
  const home = await temporaryHome()
  await mkdir(join(home, '.config', 'herdr-app'), { recursive: true })
  await serveOnce(home)
  await writeFiles(home, { '.config/herdr-app/mods/cmod/gpui-kit.d.ts': '', '.config/herdr-app/mods/cmod/.drawn/a.png': '' })

  const tornDown = await cmod(home, 'teardown', 'cmod')

  expect(tornDown.exitCode).toBe(0)
  expect([existsSync(join(home, '.config/herdr-app/mods/cmod')), existsSync(join(home, '.config/herdr-app'))]).toEqual([false, true])
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/herdr.json'), 'utf8'))).toEqual({})
}, 30_000)

class Element {
  readonly nodes: unknown[] = []
  readonly calls: Record<string, unknown[]> = {}
  readonly kind: string
  readonly args: readonly unknown[]

  constructor(kind: string, args: readonly unknown[]) {
    this.kind = kind
    this.args = args
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) =>
        key in target
          ? (target as unknown as Record<string, unknown>)[key]
          : (...args: unknown[]) => {
              if (key === 'child') target.nodes.push(args[0])
              else if (key === 'children') target.nodes.push(...(args[0] as unknown[]))
              else if (key === 'when') {
                if (args[0]) (args[1] as (element: Element) => Element)(proxy)
              } else target.calls[key] = args
              return proxy
            },
    })
    return proxy
  }
}

type Shown = Element | { render(cx: unknown): Element }

const element =
  (kind: string) =>
  (...args: unknown[]) =>
    new Element(kind, args)

const retained = (options: { readonly value?: string }, released: unknown[] = []) => {
  const state = {
    current: options.value ?? '',
    handlers: {} as Record<string, (event: object, cx: unknown) => void>,
    on(event: string, handler: (event: object, cx: unknown) => void) {
      state.handlers[event] = handler
      return true
    },
    value: () => state.current,
    set_value(next: string) {
      state.current = next
    },
    release: () => void released.push(state),
  }
  return state
}

type Herdr = {
  readonly view: { init(props: object, cx: unknown): void; render(cx: unknown): Element }
  readonly cx: { notify(target?: unknown): void }
  readonly ran: string[][]
  readonly commands: (readonly [string, Record<string, unknown>])[]
  readonly timers: (readonly [number, (cx: unknown) => void])[]
  readonly notified: unknown[]
  focus(terminal: string): void
  readonly read: string[]
  readonly written: Map<string, Uint8Array>
  readonly deleted: string[]
  readonly released: unknown[]
  follow(answer: object): void
  settled(): Promise<void>
  endFrame(): void
}

async function herdrWith(given: object, answer: (args: readonly string[]) => unknown, leftovers: readonly string[] = [], tree: object | null = null): Promise<Herdr> {
  const main = await readFile(join(source, 'main.js'), 'utf8')
  const ran: string[][] = []
  const notified: unknown[] = []
  const read: string[] = []
  const written = new Map<string, Uint8Array>(leftovers.map((path) => [path, new Uint8Array()]))
  const deleted: string[] = []
  const follows: ((answer: object) => void)[] = []
  const queued: object[] = []
  const commands: (readonly [string, Record<string, unknown>])[] = []
  const timers: (readonly [number, (cx: unknown) => void])[] = []
  const released: unknown[] = []
  const afterFrame: (() => void)[] = []
  let focusedTerminal = 't1'
  let shownPanes: { readonly pane: string; readonly mod: string; readonly tab: string }[] = []
  const run = (name: string, args: Record<string, unknown>) => {
    commands.push([name, args])
    if (name === 'tab.new') shownPanes = [...shownPanes, { pane: `p${commands.length}`, mod: String(args['mod']), tab: `tab-${commands.length}` }]
    if (name === 'tab.close') shownPanes = shownPanes.filter((pane) => pane.tab !== args['id'])
    return null
  }
  const exec = async (_command: string, args: readonly string[]) => {
    if (args.length === 2) return { code: 0, stdout: '/home/.claude', stderr: '' }
    const asked = args.slice(3)
    ran.push(asked)
    if (asked[1] === 'follow') return { code: 0, stdout: JSON.stringify(await new Promise<object>((resolve) => void (queued.length > 0 ? resolve(queued.shift() as object) : follows.push(resolve)))), stderr: '' }
    try {
      return { code: 0, stdout: JSON.stringify(answer(asked) ?? null), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: `cmod ui: ${(error as Error).message}\n` }
    }
  }
  const values: Record<string, unknown> = {
    View: class {},
    div: element('div'),
    image: element('image'),
    v_flex: element('v_flex'),
    h_flex: element('h_flex'),
    Button: { new: element('Button') },
    Tabs: { new: element('Tabs') },
    Tab: { new: element('Tab') },
    TextView: { markdown: element('TextView.markdown') },
    InputState: { new: (options: { readonly value?: string }) => retained(options, released) },
    Input: { new: element('Input') },
    TextareaState: { new: (options: { readonly value?: string }) => retained(options, released) },
    Textarea: { new: element('Textarea') },
    EditorState: { new: (options: { readonly value?: string }) => retained(options, released) },
    Editor: { new: element('Editor') },
    exec,
    checking: () => false,
    terminals: () => [
      { address: 't1', pid: 7, foreground: { pid: 42 } },
      { address: 't2', pid: 8, foreground: { pid: 43 } },
    ],
    focused: () => ({ terminal: focusedTerminal }),
    readTextFile: async (path: string) => {
      read.push(path)
      const sessionIds: Record<string, string> = { '/home/.claude/sessions/42.json': 'worker', '/home/.claude/sessions/43.json': 'other' }
      return sessionIds[path] === undefined ? null : JSON.stringify({ sessionId: sessionIds[path] })
    },
    theme: () => new Proxy({}, { get: (_target, key) => `#${String(key)}` }),
    run,
    panes: () => shownPanes,
    layout: () => tree,
    props: () => given,
    appHome: () => '/herdr',
    settings: () => ({ zoom: 1, font_family: 'JetBrains Mono' }),
    notify: () => '',
    writeFile: async (path: string, bytes: Uint8Array) => void written.set(path, bytes),
    readFile: async () => new Uint8Array(),
    mkdir: async () => undefined,
    exists: async (path: string) => written.has(path) || [...written.keys()].some((each) => each.startsWith(`${path}/`)),
    readdir: async (folder: string) => [...written.keys()].filter((each) => each.startsWith(`${folder}/`)).map((each) => each.slice(folder.length + 1)),
    unlink: async (path: string) => {
      if (!written.delete(path)) throw new Error(`ENOENT: ${path}`)
      deleted.push(path)
    },
    Buffer,
    createHash,
    deflateSync,
  }
  const evaluated = join(await temporaryHome(), 'main.js')
  await writeFile(evaluated, main.replace(/^import \{([^}]*)\} from "[^"]+";$/gm, 'const {$1} = globalThis.herdrModules;'))
  ;(globalThis as { herdrModules?: unknown }).herdrModules = values
  const { default: Cmod } = (await import(evaluated)) as { readonly default: new () => Herdr['view'] }
  const tasks: Promise<unknown>[] = []
  const cx = {
    notify: (target?: unknown) => void notified.push(target ?? 'root'),
    spawn: (body: (cx: unknown) => Promise<unknown>) => void tasks.push(body(cx)),
    timer: { after: (_ms: number, handler: () => void) => void afterFrame.push(handler), every: (ms: number, handler: (cx: unknown) => void) => void timers.push([ms, handler]) },
    sleep: () => new Promise<void>(() => undefined),
    new: (Class: new () => { init(props: object): void }, props: object) => {
      const view: { init(props: object): void } = Object.assign(new Class(), { release: () => void released.push(view) })
      view.init(props)
      return view
    },
    open_url: () => undefined,
    write_to_clipboard: () => undefined,
  }
  const view = new Cmod()
  view.init({}, cx)
  return {
    view,
    cx,
    ran,
    commands,
    timers,
    notified,
    focus: (terminal) => void (focusedTerminal = terminal),
    read,
    written,
    deleted,
    released,
    endFrame: () => {
      for (const handler of afterFrame.splice(0)) handler()
    },
    follow: (next) => void (follows.length > 0 ? (follows.shift() as (answer: object) => void)(next) : queued.push(next)),
    settled: async () => {
      for (let round = 0; round < 50; round += 1) await new Promise<void>((resolve) => void setImmediate(resolve))
    },
  }
}

function found(root: Shown, isWanted: (each: Element) => boolean, cx: unknown): Element[] {
  const shown = root instanceof Element ? root : root.render(cx)
  return [...(isWanted(shown) ? [shown] : []), ...shown.nodes.filter((node): node is Shown => node instanceof Element || (typeof node === 'object' && node !== null && 'render' in node)).flatMap((node) => found(node, isWanted, cx))]
}

function clicked(root: Shown, isWanted: (each: Element) => boolean, cx: unknown): void {
  const click = found(root, isWanted, cx)[0]?.calls['on_click']?.[0]
  if (typeof click !== 'function') throw new Error('The drawing holds no element the test can click.')
  click({}, cx)
}

const labelled = (root: Shown, cx: unknown) => found(root, (each) => each.calls['accessibility_label'] !== undefined, cx).map((each) => [each.kind, each.calls['accessibility_label']?.[0]])

const png = Buffer.from(deflateSync('a picture')).toString('base64')

const raster = Buffer.from(new Uint8Array(new Uint32Array([0x41, 0xff0000, 0x01000000, 0x42, 0xff0000, 0x01000000]).buffer)).toString('base64')

const runsView = {
  $cmodElement: 'Box',
  props: {
    flexDirection: 'column',
    children: [
      { $cmodElement: 'Text', props: { bold: true, children: ['Runs today: ', 3] } },
      { $cmodElement: 'Button', props: { key: 'demo/runs:rerun', label: 'Run again', onPress: { $cmodHandler: 11 } } },
      { $cmodElement: 'Input', props: { key: 'demo/runs:note', label: 'Note', value: 'flaky', onSubmit: { $cmodHandler: 12 } } },
      { $cmodElement: 'Select', props: { key: 'demo/runs:speed', label: 'Speed', value: 'fast', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }], onSelect: { $cmodHandler: 13 } } },
      { $cmodElement: 'Markdown', props: { key: 'demo/runs:notes', text: 'All **green**' } },
      { $cmodElement: 'Code', props: { source: 'bun test', language: 'sh' } },
      { $cmodElement: 'Image', props: { label: 'Coverage chart', columns: 10, rows: 4, source: { png } } },
      { $cmodElement: 'Raster', props: { key: 'demo/runs:grid', label: 'Run grid', columns: 2, rows: 1, cells: raster } },
    ],
  },
}

const runsSession = (asked: readonly string[]) => {
  if (asked[1] === 'list') return asked[2] === 'views' ? [{ mod: 'demo', id: 'runs', title: 'Runs' }] : []
  if (asked[1] === 'draw') return runsView
  return null
}

async function runsShown() {
  const herdr = await herdrWith({}, runsSession)
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()
  return herdr
}

test("cmod's Herdr mod draws the focused session's view as gpui-kit elements, each with its accessible name", async () => {
  const herdr = await runsShown()
  const root = herdr.view.render(herdr.cx)

  expect(herdr.read).toContain('/home/.claude/sessions/42.json')
  expect(herdr.ran).toContainEqual(['ui', 'draw', 'worker', 'demo', 'runs', '--columns', '40', '--surface', 'herdr'])
  expect(labelled(root, herdr.cx)).toEqual([
    ['Tabs', 'Views'],
    ['div', 'Runs today: 3'],
    ['Button', 'Run again'],
    ['Input', 'Note'],
    ['h_flex', 'Speed'],
    ['Button', 'Fast'],
    ['Button', 'Slow'],
    ['div', 'Coverage chart'],
    ['v_flex', 'Run grid'],
  ])
  expect(found(root, (each) => ['TextView.markdown', 'Editor', 'image'].includes(each.kind), herdr.cx).map((each) => [each.kind, each.args[0]])).toEqual([
    ['TextView.markdown', 'demo/runs:markdown:demo/runs:notes'],
    ['Editor', expect.objectContaining({ current: 'bun test' })],
    ['image', `mods/cmod/.drawn/${hashOf(Buffer.from(png, 'base64'))}.png`],
  ])
  expect(herdr.written.has(`/herdr/mods/cmod/.drawn/${hashOf(Buffer.from(png, 'base64'))}.png`)).toBe(true)
  expect(found(root, (each) => each.kind === 'div' && each.calls['text_color']?.[0] === '#ff0000', herdr.cx).map((each) => each.nodes)).toEqual([['AB']])
})

const emptyDashboard = {
  $cmodElement: 'Box',
  props: {
    flexDirection: 'column',
    flexGrow: 1,
    children: [
      {
        $cmodElement: 'Box',
        props: {
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: 13,
          borderStyle: 'round',
          borderColor: 'subtle',
          paddingX: 1,
          children: {
            $cmodElement: 'Box',
            props: {
              flexDirection: 'column',
              gap: 1,
              children: [
                { $cmodElement: 'Text', props: { dimColor: true, wrap: 'wrap', children: 'Place the widgets your mods add here, in Settings.' } },
                { $cmodElement: 'Button', props: { plain: true, key: 'cmod/dashboard:arrange-widgets', label: 'Arrange widgets', onPress: { $cmodHandler: 5 }, children: { $cmodElement: 'Text', props: { backgroundColor: 'claude', color: 'inverseText', bold: true, children: ' Arrange widgets ' } } } },
              ],
            },
          },
        },
      },
      { $cmodElement: 'Box', props: { position: 'absolute', top: 0, left: 2, children: { $cmodElement: 'Text', props: { bold: true, wrap: 'truncate-end', children: ' Widgets ' } } } },
    ],
  },
}

const callsOf = (root: Shown, cx: unknown) => found(root, () => true, cx).flatMap((each) => Object.entries(each.calls).map(([method, args]) => ({ element: each.kind, method, args })))

test("cmod's Herdr mod draws the cmod plugin's own Dashboard with a value for every argument it hands Herdr", async () => {
  const herdr = await herdrWith({}, (asked) => (asked[1] === 'list' ? (asked[2] === 'views' ? [{ mod: 'cmod', id: 'dashboard', title: 'Dashboard' }] : []) : emptyDashboard))
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()

  const calls = callsOf(herdr.view.render(herdr.cx), herdr.cx)

  expect(calls.filter(({ args }) => args.some((arg) => arg === undefined || arg === null || Number.isNaN(arg)))).toEqual([])
  expect(calls.filter(({ method }) => method === 'flex_grow').map(({ args }) => args)).toEqual([[1], [1]])
})

test("a press in cmod's Herdr mod runs cmod ui press with the handler of the element pressed, and the surface herdr", async () => {
  const herdr = await runsShown()
  const root = herdr.view.render(herdr.cx)
  const note = found(root, (each) => each.kind === 'Input', herdr.cx)[0]?.args[0] as ReturnType<typeof retained>

  clicked(root, (each) => each.kind === 'Button' && each.calls['accessibility_label']?.[0] === 'Run again', herdr.cx)
  clicked(root, (each) => each.kind === 'Button' && each.calls['accessibility_label']?.[0] === 'Slow', herdr.cx)
  note.set_value('flaky on Linux')
  note.handlers['submit']?.({}, herdr.cx)
  await herdr.settled()

  expect(herdr.ran.filter((args) => args[1] === 'press')).toEqual([
    ['ui', 'press', 'worker', '11', '{"surface":"herdr","key":"demo/runs:rerun"}'],
    ['ui', 'press', 'worker', '13', '{"surface":"herdr","key":"demo/runs:speed","value":"slow"}'],
    ['ui', 'press', 'worker', '12', '{"surface":"herdr","key":"demo/runs:note","kind":"submit","value":"flaky on Linux"}'],
  ])
})

test("a Redraw redraws only the unit it names in cmod's Herdr mod", async () => {
  const widget = (id: string) => ({ mod: 'demo', id, areas: ['dashboard'] })
  const draws = new Map<string, number>()
  const herdr = await herdrWith({ show: 'widgets', area: 'dashboard' }, (asked) => {
    if (asked[1] === 'list') return [widget('cost'), widget('branch')]
    const id = asked[4] as string
    draws.set(id, (draws.get(id) ?? 0) + 1)
    return { $cmodElement: 'Text', props: { children: `${id} draw ${draws.get(id)}` } }
  })
  herdr.follow({ cursor: '1:0:0', events: [], missed: true })
  await herdr.settled()
  const ranBefore = herdr.ran.length
  herdr.notified.length = 0

  herdr.follow({ cursor: '1:0:1', events: [{ event: 'Redraw', session: 'worker', mod: 'demo', id: 'branch' }], missed: false })
  await herdr.settled()

  const units = (herdr.view as unknown as { readonly units: ReadonlyMap<string, { readonly entity: Shown }> }).units
  expect(herdr.ran.slice(ranBefore).filter((args) => args[1] !== 'follow')).toEqual([['ui', 'draw', 'worker', 'demo', 'branch', '--columns', '40', '--surface', 'herdr', '--area', 'dashboard']])
  expect(herdr.notified).toEqual([units.get('demo/branch')?.entity])
  expect([...units.values()].map((unit) => labelled(unit.entity, herdr.cx))).toEqual([[['div', 'cost draw 1']], [['div', 'branch draw 2']]])
})

test("cmod's Herdr mod keeps only the image files its drawings show, and deletes an old one once no drawing shows it", async () => {
  const drawn = (text: string) => `/herdr/mods/cmod/.drawn/${hashOf(Buffer.from(text))}.png`
  const leftover = drawn('left by an earlier run')
  const pictures = new Map([['cost', 'chart 1'], ['branch', 'chart 1']])
  const herdr = await herdrWith(
    { show: 'widgets', area: 'dashboard' },
    (asked) => {
      if (asked[1] === 'list') return [{ mod: 'demo', id: 'cost', areas: ['dashboard'] }, { mod: 'demo', id: 'branch', areas: ['dashboard'] }]
      return { $cmodElement: 'Image', props: { label: 'Chart', columns: 10, rows: 4, source: { png: Buffer.from(pictures.get(asked[4] as string) as string).toString('base64') } } }
    },
    [leftover],
  )
  herdr.follow({ cursor: '1:0:0', events: [], missed: true })
  await herdr.settled()

  expect(herdr.deleted).toEqual([leftover])
  expect([...herdr.written.keys()]).toEqual([drawn('chart 1')])

  pictures.set('branch', 'chart 2')
  herdr.follow({ cursor: '1:0:1', events: [{ event: 'Redraw', session: 'worker', mod: 'demo', id: 'branch' }], missed: false })
  await herdr.settled()

  expect(herdr.deleted).toEqual([leftover])
  expect([...herdr.written.keys()].sort()).toEqual([drawn('chart 1'), drawn('chart 2')].sort())

  pictures.set('cost', 'chart 2')
  herdr.follow({ cursor: '1:0:2', events: [{ event: 'Redraw', session: 'worker', mod: 'demo', id: 'cost' }], missed: false })
  await herdr.settled()

  expect(herdr.deleted).toEqual([leftover, drawn('chart 1')])
  expect([...herdr.written.keys()]).toEqual([drawn('chart 2')])

  await (herdr.view as unknown as { close(): Promise<void> }).close()

  expect(herdr.deleted).toEqual([leftover, drawn('chart 1'), drawn('chart 2')])
  expect(herdr.written.size).toBe(0)
})

test("cmod's Herdr mod draws each widget for the area its props name, and leaves out a widget that does not list it", async () => {
  const herdr = await herdrWith({ show: 'widgets', area: 'belowPrompt' }, (asked) => {
    if (asked[1] === 'list') return [{ mod: 'demo', id: 'branch', areas: ['belowPrompt', 'dashboard'] }, { mod: 'demo', id: 'cost', areas: ['dashboard'] }]
    return { $cmodElement: 'Text', props: { children: 'main' } }
  })

  herdr.follow({ cursor: '1:0:0', events: [], missed: true })
  await herdr.settled()

  expect(herdr.ran.filter((args) => args[1] !== 'follow')).toEqual([
    ['ui', 'list', 'widgets', 'worker'],
    ['ui', 'draw', 'worker', 'demo', 'branch', '--columns', '40', '--surface', 'herdr', '--area', 'belowPrompt'],
  ])
})

const sessionViews = [
  { mod: 'cmod', id: 'dashboard', title: 'Dashboard' },
  { mod: 'demo', id: 'runs', title: 'Runs' },
]

const viewsAndLog = (asked: readonly string[]) => {
  if (asked[1] === 'list') return asked[2] === 'views' ? sessionViews : [{ mod: 'demo', id: 'log', title: 'Log' }]
  return { $cmodElement: 'Text', props: { children: `${asked[3]}/${asked[4]}` } }
}

const tabsOf = (herdr: Herdr) => found(herdr.view.render(herdr.cx), (each) => each.kind === 'Tab', herdr.cx).map((each) => [each.args[0], each.calls['selected']?.[0], each.nodes])

test("the dock of cmod's Herdr mod shows the session's views as its tabs, in the order cmod/UI lists them, and draws the first one", async () => {
  const herdr = await herdrWith({}, viewsAndLog)

  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()

  expect(tabsOf(herdr)).toEqual([
    ['cmod-tab-cmod/dashboard', true, ['Dashboard']],
    ['cmod-tab-demo/runs', false, ['Runs']],
  ])
  expect(herdr.ran.filter((args) => args[1] === 'list' || args[1] === 'draw')).toEqual([
    ['ui', 'list', 'views', 'worker'],
    ['ui', 'list', 'pages', 'worker'],
    ['ui', 'draw', 'worker', 'cmod', 'dashboard', '--columns', '40', '--surface', 'herdr'],
  ])
})

test("cmod's Herdr mod opens a page a mod opened as a Herdr tab, closes that tab on Close, and shows a view a mod opened as the dock's tab", async () => {
  const herdr = await herdrWith({}, viewsAndLog)
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()

  herdr.follow({ cursor: '1:0:0:1:0', events: [{ event: 'Open', session: 'worker', mod: 'demo', id: 'log' }], missed: false })
  await herdr.settled()
  herdr.view.render(herdr.cx)
  herdr.follow({ cursor: '1:0:0:2:1', events: [{ event: 'Open', session: 'worker', mod: 'demo', id: 'runs' }, { event: 'Close', session: 'worker', mod: 'demo', id: 'log' }, { event: 'Open', session: 'other', mod: 'demo', id: 'log' }], missed: false })
  await herdr.settled()

  expect(herdr.commands).toEqual([
    ['tab.new', { name: 'Log', mod: 'cmod', props: { show: 'page', session: 'worker', mod: 'demo', id: 'log', title: 'Log' } }],
    ['tab.close', { id: 'tab-1' }],
  ])
  expect(tabsOf(herdr).map(([tab, isSelected]) => [tab, isSelected])).toEqual([
    ['cmod-tab-cmod/dashboard', false],
    ['cmod-tab-demo/runs', true],
  ])
  expect(herdr.ran.filter((args) => args[1] === 'draw').at(-1)).toEqual(['ui', 'draw', 'worker', 'demo', 'runs', '--columns', '40', '--surface', 'herdr'])
})

const shownBy = (herdr: Herdr) => herdr.ran.filter((args) => args[1] === 'show')

const clientOf = (herdr: Herdr) => (herdr.view as unknown as { readonly client: string }).client

test("a window of cmod's Herdr mod tells cmod/UI show the view it shows, again when its tab or focused session changes, renews it inside the lease, and clears it when it closes", async () => {
  const herdr = await herdrWith({ show: 'views', overlay: 'o1' }, viewsAndLog)
  const client = clientOf(herdr)
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()

  clicked(herdr.view.render(herdr.cx), (each) => each.kind === 'Tab' && each.args[0] === 'cmod-tab-demo/runs', herdr.cx)
  await herdr.settled()
  const [renewal] = herdr.timers
  renewal?.[1](herdr.cx)
  await herdr.settled()
  herdr.focus('t2')
  herdr.view.render(herdr.cx)
  await herdr.settled()
  herdr.follow({ cursor: '2:0:0:0:0', events: [], missed: true })
  await herdr.settled()
  await (herdr.view as unknown as { close(): Promise<void> }).close()

  expect(client).toMatch(/^herdr-/)
  expect(herdr.timers.map(([ms]) => ms < 16_000)).toEqual([true])
  expect(shownBy(herdr)).toEqual([
    ['ui', 'show', 'worker', client, '--host'],
    ['ui', 'show', 'worker', client, 'cmod/dashboard', '--host'],
    ['ui', 'show', 'worker', client, 'demo/runs', '--host'],
    ['ui', 'show', 'worker', client, 'demo/runs', '--host'],
    ['ui', 'show', 'worker', client],
    ['ui', 'show', 'other', client, '--host'],
    ['ui', 'show', 'other', client, 'cmod/dashboard', '--host'],
    ['ui', 'show', 'other', client],
  ])
})

const panelLayout = {
  id: 'root',
  type: 'row',
  children: [
    { id: 'work', type: 'block', content: { tab: 'active' } },
    { id: 'side', type: 'column', hidden: true, children: [{ id: 'body', type: 'stack', active: 'files', children: [{ id: 'files', type: 'block', content: { mod: 'files' } }, { id: 'views', type: 'block', content: { mod: 'cmod', props: { show: 'views' } } }] }] },
  ],
}

test("a dock of cmod's Herdr mod in any layout hosts the session with cmod/UI show --host, even with no view to show, and shows its own block for an Open the person asked for, and only for it, while a window hosts and changes no layout", async () => {
  const herdr = await herdrWith({ show: 'views' }, (asked) => (asked[1] === 'list' ? (asked[2] === 'views' ? sessionViews : []) : viewsAndLog(asked)), [], panelLayout)
  const client = clientOf(herdr)
  const bare = await herdrWith({ show: 'views', overlay: 'o1' }, () => [], [], panelLayout)
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  bare.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await Promise.all([herdr.settled(), bare.settled()])

  herdr.follow({ cursor: '1:0:0:1:0', events: [{ event: 'Open', session: 'worker', mod: 'demo', id: 'runs' }], missed: false })
  await herdr.settled()
  const unasked = [...herdr.commands]
  herdr.follow({ cursor: '1:0:0:2:0', events: [{ event: 'Open', session: 'worker', mod: 'cmod', id: 'dashboard', isAsked: true }], missed: false })
  await herdr.settled()

  expect(shownBy(herdr).slice(0, 2)).toEqual([
    ['ui', 'show', 'worker', client, '--host'],
    ['ui', 'show', 'worker', client, 'cmod/dashboard', '--host'],
  ])
  expect(unasked).toEqual([])
  expect(herdr.commands).toEqual([
    ['layout.show', { id: 'side' }],
    ['layout.select', { stack: 'body', child: 'views' }],
  ])
  expect(tabsOf(herdr).map(([tab, isSelected]) => [tab, isSelected])).toEqual([
    ['cmod-tab-cmod/dashboard', true],
    ['cmod-tab-demo/runs', false],
  ])
  expect(shownBy(bare)).toEqual([['ui', 'show', 'worker', clientOf(bare), '--host']])
  expect(bare.commands).toEqual([])
})

test("cmod's Herdr mod releases a view it stops showing only after a frame that no longer draws it, so Herdr never mounts a released entity", async () => {
  const herdr = await herdrWith({}, viewsAndLog)
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()
  const units = (herdr.view as unknown as { readonly units: ReadonlyMap<string, { readonly entity: Shown }> }).units
  const dashboard = units.get('cmod/dashboard')?.entity

  clicked(herdr.view.render(herdr.cx), (each) => each.kind === 'Tab' && each.args[0] === 'cmod-tab-demo/runs', herdr.cx)
  await herdr.settled()
  const releasedBeforeFrame = [...herdr.released]
  const drawn = found(herdr.view.render(herdr.cx), () => true, herdr.cx)
  const releasedBeforeFrameEnds = [...herdr.released]
  herdr.endFrame()

  expect(dashboard).toBeDefined()
  expect(releasedBeforeFrame).not.toContain(dashboard)
  expect(releasedBeforeFrameEnds).not.toContain(dashboard)
  expect(drawn).not.toContain(dashboard)
  expect(herdr.released).toContain(dashboard)
})

test("cmod's Herdr mod shows why a session shows nothing in place of its views, and never says a session shows no views", async () => {
  const refusal = 'Session worker runs a cmod plugin older than this cmod serve, so its views show only in Claude Code. Run /reload-plugins in it to show them here.'
  const herdr = await herdrWith({}, () => {
    throw new Error(refusal)
  })
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: false })
  await herdr.settled()

  expect(labelled(herdr.view.render(herdr.cx), herdr.cx)).toEqual([
    ['Tabs', 'Views'],
    ['div', `cmod ui: ${refusal}`],
  ])
})

test("cmod's Herdr mod drops a list that answers after its focused session changed, so it never shows one session's tabs over another", async () => {
  const herdr = await herdrWith({}, viewsAndLog)
  const view = herdr.view as unknown as { list(part: string): Promise<void>; session: string | null; readonly lists: { readonly views: readonly object[] } }
  view.session = 'worker'

  const listed = view.list('views')
  view.session = 'other'
  await listed

  expect(herdr.ran).toContainEqual(['ui', 'list', 'views', 'worker'])
  expect(view.lists.views).toEqual([])
})

test("a page tab of cmod's Herdr mod tells cmod/UI show its page, and a widgets block tells nothing and renews nothing", async () => {
  const page = await herdrWith({ show: 'page', session: 'worker', mod: 'demo', id: 'log', title: 'Log' }, viewsAndLog)
  const widgets = await herdrWith({ show: 'widgets', area: 'belowPrompt' }, () => [{ mod: 'demo', id: 'branch', areas: ['belowPrompt'] }])
  widgets.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await Promise.all([page.settled(), widgets.settled()])

  expect(shownBy(page)).toEqual([['ui', 'show', 'worker', clientOf(page), 'demo/log']])
  expect([shownBy(widgets), widgets.timers]).toEqual([[], []])
})

test("a Close of the view the dock of cmod's Herdr mod shows goes back to the first view, as the Sidebar takes a closed view away", async () => {
  const herdr = await herdrWith({}, viewsAndLog)
  herdr.follow({ cursor: '1:0:0:0:0', events: [], missed: true })
  await herdr.settled()
  clicked(herdr.view.render(herdr.cx), (each) => each.kind === 'Tab' && each.args[0] === 'cmod-tab-demo/runs', herdr.cx)
  await herdr.settled()

  herdr.follow({ cursor: '1:0:0:0:1', events: [{ event: 'Close', session: 'worker', mod: 'demo', id: 'runs' }], missed: false })
  await herdr.settled()

  expect(tabsOf(herdr).map(([tab, isSelected]) => [tab, isSelected])).toEqual([
    ['cmod-tab-cmod/dashboard', true],
    ['cmod-tab-demo/runs', false],
  ])
  expect(herdr.commands).toEqual([])
})
