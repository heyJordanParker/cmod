import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
  const panel = await readFile(join(source, 'panel.js'), 'utf8')
  const modJson = await readFile(join(folder, 'mod.json'), 'utf8')
  expect(await readFile(join(folder, 'main.js'), 'utf8')).toBe(main)
  expect(await readFile(join(folder, 'panel.js'), 'utf8')).toBe(panel)
  expect(JSON.parse(modJson)).toEqual({ place: 'none', overlay: { kind: 'window', key: 'cmod', width: 360, height: 600, props: { show: 'views' } } })
  expect(JSON.parse(await readFile(join(home, '.local/share/cmod/herdr.json'), 'utf8'))).toEqual({ [folder]: { 'main.js': hashOf(main), 'panel.js': hashOf(panel), 'mod.json': hashOf(modJson) } })
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
              if (key === 'child' || key === 'children') {
                const given = key === 'child' ? [args[0]] : (args[0] as unknown[])
                const refused = given.find((each) => !(each instanceof Element) && typeof each !== 'string' && typeof each !== 'number')
                if (refused !== undefined || !Array.isArray(given)) throw new Error(`Herdr refuses ${String(refused)} as a child of ${target.kind}: a child is an element, a string, or a number.`)
                target.nodes.push(...given)
              } else if (key === 'when') {
                if (args[0]) (args[1] as (element: Element) => Element)(proxy)
              } else target.calls[key] = args
              return proxy
            },
    })
    return proxy
  }
}

const themeColors = [
  'background', 'surface', 'canvas', 'chrome', 'popover', 'raised', 'hover', 'selected', 'border', 'input', 'foreground', 'muted', 'dim', 'accent', 'accent_foreground',
  'solid', 'solid_foreground', 'selection', 'working', 'blocked', 'done', 'idle', 'unknown', ...Array.from({ length: 16 }, (_, index) => `ansi${index}`),
]

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

type Asked = readonly [string, unknown]

type Answer = (method: string, params: readonly unknown[]) => unknown

const unanswered = Symbol('a call cmod serve never answers')

type Herdr = {
  readonly view: { init(props: object, cx: unknown): void; render(cx: unknown): Element; close(): Promise<void> }
  readonly cx: unknown
  readonly asked: Asked[]
  readonly commands: (readonly [string, Record<string, unknown>])[]
  readonly timers: (readonly [number, (cx: unknown) => void])[]
  notified(): number
  focus(terminal: string): void
  tell(event: string, payload: object): void
  readonly written: Map<string, Uint8Array>
  readonly deleted: string[]
  readonly released: unknown[]
  settled(): Promise<void>
  endFrame(): void
  drop(): void
  render(): Element
}

const store = '/home/.local/share/cmod'

async function herdrWith(given: object, answer: Answer, { leftovers = [], tree = null, isServing = true, failedSessionReads = 0 }: { readonly leftovers?: readonly string[]; readonly tree?: object | null; readonly isServing?: boolean; readonly failedSessionReads?: number } = {}): Promise<Herdr> {
  const folder = join(await temporaryHome(), 'herdr-mod')
  await mkdir(folder)
  const main = await readFile(join(source, 'main.js'), 'utf8')
  await writeFile(join(folder, 'main.js'), main.replace(/^import \{([^}]*)\} from "(?!\.)[^"]+";$/gm, 'const {$1} = globalThis.herdrModules;'))
  await copyFile(join(source, 'panel.js'), join(folder, 'panel.js'))
  const asked: Asked[] = []
  const written = new Map<string, Uint8Array>(leftovers.map((path) => [path, new Uint8Array()]))
  const deleted: string[] = []
  const commands: (readonly [string, Record<string, unknown>])[] = []
  const timers: (readonly [number, (cx: unknown) => void])[] = []
  const released: unknown[] = []
  const afterFrame: (() => void)[] = []
  const inbox: string[] = []
  let wake: () => void = () => undefined
  let isDropped = false
  let notified = 0
  let sessionReadsToFail = failedSessionReads
  let focusedTerminal = 't1'
  let shownPanes: { readonly pane: string; readonly mod: string; readonly tab: string }[] = []
  const deliver = (message: object) => {
    inbox.push(JSON.stringify(message))
    wake()
  }
  const socket = {
    write: async (text: string) => {
      const { id, method, params } = JSON.parse(text) as { readonly id?: number; readonly method: string; readonly params: readonly unknown[] }
      asked.push([method, params])
      if (id === undefined) return
      if (method === '$/listen') return deliver({ jsonrpc: '2.0', id, result: null })
      try {
        const result = answer(method, params)
        if (result === unanswered) return
        deliver({ jsonrpc: '2.0', id, result: result ?? null })
      } catch (error) {
        deliver({ jsonrpc: '2.0', id, error: { code: -32098, message: (error as Error).message } })
      }
    },
    read: async () => {
      while (inbox.length === 0) {
        if (isDropped) throw new Error('WebSocket connection is closed')
        await new Promise<void>((resolve) => (wake = resolve))
      }
      return inbox.shift() as string
    },
    close: async () => undefined,
  }
  const values: Record<string, unknown> = {
    View: class {},
    div: element('div'),
    image: element('image'),
    svg: element('svg'),
    v_flex: element('v_flex'),
    h_flex: element('h_flex'),
    Button: { new: element('Button') },
    Tabs: { new: element('Tabs') },
    Tab: { new: element('Tab') },
    Switch: { new: element('Switch') },
    Progress: { new: element('Progress') },
    ProgressTrack: { new: element('ProgressTrack') },
    ProgressIndicator: { new: element('ProgressIndicator') },
    Popover: { new: element('Popover') },
    TextView: { markdown: element('TextView.markdown') },
    InputState: { new: (options: { readonly value?: string }) => retained(options, released) },
    Input: { new: element('Input') },
    TextareaState: { new: (options: { readonly value?: string }) => retained(options, released) },
    Textarea: { new: element('Textarea') },
    EditorState: { new: (options: { readonly value?: string }) => retained(options, released) },
    Editor: { new: element('Editor') },
    WebSocket: {
      connect: async (url: string) => {
        if (!isServing || url !== 'ws://127.0.0.1:4100/ui?token=secret') throw new Error(`refused ${url}`)
        isDropped = false
        return socket
      },
    },
    exec: async () => ({ code: 0, stdout: `/home/.claude\n${store}`, stderr: '' }),
    checking: () => false,
    terminals: () => [
      { address: 't1', pid: 7, foreground: { pid: 42 } },
      { address: 't2', pid: 8, foreground: { pid: 43 } },
    ],
    focused: () => ({ terminal: focusedTerminal }),
    readTextFile: async (path: string) => {
      if (path === `${store}/serve.json`) return isServing ? JSON.stringify({ url: 'ws://127.0.0.1:4100/ui', token: 'secret' }) : null
      const sessionIds: Record<string, string> = { '/home/.claude/sessions/42.json': 'worker', '/home/.claude/sessions/43.json': 'other' }
      if (sessionIds[path] !== undefined && sessionReadsToFail > 0) {
        sessionReadsToFail -= 1
        throw new Error(`EIO: ${path}`)
      }
      return sessionIds[path] === undefined ? null : JSON.stringify({ sessionId: sessionIds[path] })
    },
    theme: () => Object.fromEntries(themeColors.map((name) => [name, `#${name}`])),
    run: (name: string, args: Record<string, unknown>) => {
      commands.push([name, args])
      if (name === 'tab.new') shownPanes = [...shownPanes, { pane: `p${commands.length}`, mod: String(args['mod']), tab: `tab-${commands.length}` }]
      if (name === 'tab.close') shownPanes = shownPanes.filter((pane) => pane.tab !== args['id'])
      return null
    },
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
    readdir: async (at: string) => [...written.keys()].filter((each) => each.startsWith(`${at}/`)).map((each) => each.slice(at.length + 1)),
    unlink: async (path: string) => {
      if (!written.delete(path)) throw new Error(`ENOENT: ${path}`)
      deleted.push(path)
    },
    Buffer,
    createHash,
    deflateSync,
  }
  ;(globalThis as { herdrModules?: unknown }).herdrModules = values
  const { default: Cmod } = (await import(join(folder, 'main.js'))) as { readonly default: new () => Herdr['view'] }
  const cx = {
    notify: () => void (notified += 1),
    spawn: (body: (cx: unknown) => Promise<unknown>) => void body(cx),
    timer: { after: (_ms: number, handler: (cx: unknown) => void) => void afterFrame.push(() => handler(cx)), every: (ms: number, handler: (cx: unknown) => void) => void timers.push([ms, handler]) },
    open_url: () => undefined,
    write_to_clipboard: () => undefined,
  }
  const view = new Cmod()
  view.init({}, cx)
  const settled = async () => {
    for (let round = 0; round < 50; round += 1) await new Promise<void>((resolve) => void setImmediate(resolve))
  }
  await settled()
  view.render(cx)
  await settled()
  return {
    view,
    cx,
    asked,
    commands,
    timers,
    notified: () => notified,
    focus: (terminal) => void (focusedTerminal = terminal),
    tell: (event, payload) => deliver({ jsonrpc: '2.0', method: '$/on', params: { id: event, payload } }),
    written,
    deleted,
    released,
    endFrame: () => {
      for (const handler of afterFrame.splice(0)) handler()
    },
    settled,
    drop: () => {
      isDropped = true
      wake()
    },
    render: () => view.render(cx),
  }
}

const slotsOf = (each: Element) => ['trigger', 'content'].flatMap((slot) => (each.calls[slot] ?? []).filter((node): node is Element => node instanceof Element))

function found(root: Element, isWanted: (each: Element) => boolean): Element[] {
  return [...(isWanted(root) ? [root] : []), ...[...slotsOf(root), ...root.nodes].filter((node): node is Element => node instanceof Element).flatMap((node) => found(node, isWanted))]
}

function clicked(root: Element, isWanted: (each: Element) => boolean, cx: unknown): void {
  const click = found(root, isWanted)[0]?.calls['on_click']?.[0]
  if (typeof click !== 'function') throw new Error('The drawing holds no element the test can click.')
  click({}, cx)
}

const labelled = (root: Element) => found(root, (each) => each.calls['accessibility_label'] !== undefined).map((each) => [each.kind, each.calls['accessibility_label']?.[0]])

const calledWith = (herdr: Herdr, method: string) => herdr.asked.filter(([called]) => called === method).map(([, params]) => params)

const png = Buffer.from(deflateSync('a picture')).toString('base64')

const raster = Buffer.from(new Uint8Array(new Uint32Array([0x41, 0xff0000, 0x01000000, 0x42, 0xff0000, 0x01000000]).buffer)).toString('base64')

const sessionViews = [
  { mod: 'cmod', id: 'dashboard', title: 'Dashboard' },
  { mod: 'demo', id: 'runs', title: 'Runs' },
]

const listing =
  (draw: (params: readonly unknown[]) => unknown, lists: { readonly views?: readonly object[]; readonly pages?: readonly object[]; readonly widgets?: readonly object[] } = {}): Answer =>
  (method, params) => {
    if (method === 'cmod/UI.views') return lists.views ?? sessionViews
    if (method === 'cmod/UI.pages') return lists.pages ?? [{ mod: 'demo', id: 'log', title: 'Log' }]
    if (method === 'cmod/UI.widgets') return lists.widgets ?? []
    if (method === 'cmod/UI.draw') return draw(params)
    return null
  }

const partOf = (params: readonly unknown[]) => params[1] as { readonly mod: string; readonly id: string }

const named = listing((params) => ({ $cmodElement: 'Text', props: { children: `${params[0]}/${partOf(params).mod}/${partOf(params).id}` } }))

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

const runsShown = () => herdrWith({}, listing(() => runsView, { views: [{ mod: 'demo', id: 'runs', title: 'Runs' }], pages: [] }))

test("cmod's Herdr mod reaches cmod serve over the one WebSocket serve.json names, hears its four events, and draws the focused session's view as gpui-kit elements, each with its accessible name", async () => {
  const herdr = await runsShown()
  const root = herdr.render()

  expect(calledWith(herdr, '$/listen').map((params) => (params as { readonly event: string }).event)).toEqual(['Change', 'Redraw', 'Open', 'Close'])
  expect(calledWith(herdr, 'cmod/UI.draw')).toEqual([['worker', { mod: 'demo', id: 'runs' }, { columns: 40, surface: 'herdr' }]])
  expect(labelled(root)).toEqual([
    ['Tabs', 'Views'],
    ['Tab', 'Runs'],
    ['div', 'Runs today: 3'],
    ['Button', 'Run again'],
    ['Input', 'Note'],
    ['div', 'Speed: Fast'],
    ['v_flex', 'Speed'],
    ['Button', 'Fast'],
    ['Button', 'Slow'],
    ['div', 'Coverage chart'],
    ['v_flex', 'Run grid'],
  ])
  expect(found(root, (each) => ['TextView.markdown', 'Editor', 'image'].includes(each.kind)).map((each) => [each.kind, each.args[0]])).toEqual([
    ['TextView.markdown', 'demo/runs:markdown:demo/runs:notes'],
    ['Editor', expect.objectContaining({ current: 'bun test' })],
    ['image', `mods/cmod/.drawn/${hashOf(Buffer.from(png, 'base64'))}.png`],
  ])
  expect(found(root, (each) => each.kind === 'div' && each.calls['text_color']?.[0] === '#ff0000').map((each) => each.nodes)).toEqual([['AB']])
})

const kit = {
  $cmodElement: 'Box',
  props: {
    flexDirection: 'column',
    children: [
      { $cmodElement: 'Panel', props: { title: 'Mods', children: { $cmodElement: 'List', props: { label: 'Mods', children: [{ $cmodElement: 'ListItem', props: { key: 'demo/kit:mod:cmod', label: 'cmod', tone: 'neutral', isSelected: true } }, { $cmodElement: 'ListItem', props: { key: 'demo/kit:mod:old', label: 'old', tone: 'off', onPress: { $cmodHandler: 1 } } }, { $cmodElement: 'ListItem', props: { key: 'demo/kit:run:1', label: 'bun test', leading: 'Bash', depth: 1, isOpen: false, onToggle: { $cmodHandler: 7 }, trailing: { $cmodElement: 'Badge', props: { tone: 'critical', children: 'failed' } } } }] } } } },
      { $cmodElement: 'Tabs', props: { key: 'demo/kit:', tabs: [{ key: 'options', label: 'Options', isSelected: true, onSelect: { $cmodHandler: 2 } }, { key: 'log', label: 'Log', isSelected: false, onSelect: { $cmodHandler: 3 } }], children: { $cmodElement: 'Text', props: { children: 'body' } } } },
      { $cmodElement: 'Toggle', props: { key: 'demo/kit:', label: 'Show errors', checked: true, onToggle: { $cmodHandler: 4 } } },
      { $cmodElement: 'Progress', props: { value: 40, width: 10, label: 'Context used' } },
      { $cmodElement: 'Pagination', props: { page: 1, pages: 2, onNext: { $cmodHandler: 5 } } },
      { $cmodElement: 'Badge', props: { tone: 'warning', children: 'warning' } },
      { $cmodElement: 'Banner', props: { tone: 'warning', children: 'Needs setup: a branch', actions: [{ $cmodElement: 'Button', props: { key: 'demo/kit:finish', label: 'Finish setup', variant: 'primary', onPress: { $cmodHandler: 6 } } }] } },
      { $cmodElement: 'Tooltip', props: { key: 'demo/kit:', text: 'Files Claude read', children: { $cmodElement: 'Text', props: { children: '3 read' } } } },
    ],
  },
}

test("cmod's Herdr mod draws each host component as Herdr's own control: a Panel as a titled section with no card, a List of rows and tree rows, Tabs, a Switch, a progress bar, Pagination, a tinted Badge and Banner, and a tooltip", async () => {
  const herdr = await herdrWith({}, listing(() => kit, { views: [{ mod: 'demo', id: 'kit', title: 'Kit' }], pages: [] }))
  const root = herdr.render()
  const drawn = found(root, () => true)

  expect(drawn.filter((each) => each.calls['role']?.[0] === 'heading').map((each) => each.nodes)).toEqual([['Mods']])
  expect(drawn.filter((each) => each.calls['role']?.[0] === 'region').map((each) => [each.calls['accessibility_label']?.[0], each.calls['border_1']])).toEqual([['Mods', undefined]])
  expect(drawn.filter((each) => each.calls['role']?.[0] === 'tree_item').map((each) => [each.calls['accessibility_label']?.[0], each.calls['aria_level']?.[0], each.calls['pl']?.[0]])).toEqual([['bun test', 2, 16]])
  expect(drawn.filter((each) => each.calls['role']?.[0] === 'disclosure_triangle').map((each) => [each.calls['accessibility_label']?.[0], each.nodes.map((node) => (node instanceof Element ? [node.kind, node.args[0]] : node))])).toEqual([['Open bun test', [['svg', 'mods/workspace-chrome/chevron-right.svg']]]])
  expect(drawn.filter((each) => each.nodes.includes('Bash') || each.nodes.includes('failed')).map((each) => [each.nodes[0], each.calls['text_color']?.[0]])).toEqual([
    ['Bash', '#muted'],
    ['failed', '#blocked'],
  ])
  expect(drawn.filter((each) => each.calls['role']?.[0] === 'list').map((each) => each.calls['accessibility_label'])).toEqual([['Mods']])
  expect(drawn.filter((each) => each.kind === 'Tab' && each.args[0] !== 'cmod-tab-demo/kit').map((each) => [each.args[0], each.calls['selected']?.[0]])).toEqual([
    ['demo/kit:demo/kit:tab:options', true],
    ['demo/kit:demo/kit:tab:log', false],
  ])
  expect(drawn.find((each) => each.kind === 'Switch')?.calls['checked']).toEqual([true])
  expect([drawn.find((each) => each.kind === 'Progress')?.calls['value'], drawn.find((each) => each.kind === 'ProgressIndicator')?.calls['w']]).toEqual([[40], ['40%']])
  expect(drawn.filter((each) => each.kind === 'Button' && each.calls['disabled'] !== undefined).map((each) => [each.calls['accessibility_label']?.[0], each.calls['disabled']?.[0]])).toEqual([
    ['Previous', true],
    ['Next', false],
  ])
  expect(drawn.filter((each) => each.calls['role']?.[0] === 'status').map((each) => [each.calls['border_1'], each.calls['bg']?.[0]])).toEqual([[undefined, '#raised']])
  expect(drawn.find((each) => each.calls['tooltip']?.[0] === 'Files Claude read')?.kind).toBe('h_flex')
  expect(drawn.some((each) => each.calls['absolute'] !== undefined)).toBe(false)
})

test("a press on a host component in cmod's Herdr mod runs its own handler through cmod/UI press, with the surface herdr", async () => {
  const herdr = await herdrWith({}, listing(() => kit, { views: [{ mod: 'demo', id: 'kit', title: 'Kit' }], pages: [] }))
  const root = herdr.render()

  clicked(root, (each) => each.kind === 'Tab' && each.args[0] === 'demo/kit:demo/kit:tab:log', herdr.cx)
  clicked(root, (each) => each.kind === 'Button' && each.calls['accessibility_label']?.[0] === 'old', herdr.cx)
  clicked(root, (each) => each.kind === 'Button' && each.calls['accessibility_label']?.[0] === 'Open bun test', herdr.cx)
  const turn = found(root, (each) => each.kind === 'Switch')[0]?.calls['on_change']?.[0]
  if (typeof turn !== 'function') throw new Error('The drawing holds no Switch the test can turn.')
  turn(false, herdr.cx)
  await herdr.settled()

  expect(calledWith(herdr, 'cmod/UI.press')).toEqual([
    ['worker', 3, { surface: 'herdr', key: 'demo/kit:tab:log' }],
    ['worker', 1, { surface: 'herdr', key: 'demo/kit:mod:old' }],
    ['worker', 7, { surface: 'herdr', key: 'demo/kit:run:1:toggle' }],
    ['worker', 4, { surface: 'herdr', key: 'demo/kit:toggle:Show errors' }],
  ])
})

test("a press on an element in cmod's Herdr mod runs cmod/UI press with the handler of the element pressed, and the value a field or a choice gives", async () => {
  const herdr = await runsShown()
  const root = herdr.render()
  const note = found(root, (each) => each.kind === 'Input')[0]?.args[0] as ReturnType<typeof retained>

  clicked(root, (each) => each.kind === 'Button' && each.calls['accessibility_label']?.[0] === 'Run again', herdr.cx)
  clicked(root, (each) => each.kind === 'Button' && each.calls['accessibility_label']?.[0] === 'Slow', herdr.cx)
  note.set_value('flaky on Linux')
  note.handlers['submit']?.({}, herdr.cx)
  await herdr.settled()

  expect(calledWith(herdr, 'cmod/UI.press')).toEqual([
    ['worker', 11, { surface: 'herdr', key: 'demo/runs:rerun' }],
    ['worker', 13, { surface: 'herdr', key: 'demo/runs:speed', value: 'slow' }],
    ['worker', 12, { surface: 'herdr', key: 'demo/runs:note', kind: 'submit', value: 'flaky on Linux' }],
  ])
})

test("the dock of cmod's Herdr mod keeps its tabs on one row that scrolls, and lists the session's open pages there as links to their own Herdr tabs", async () => {
  const herdr = await herdrWith({}, named)
  const root = herdr.render()
  const strip = found(root, (each) => each.kind === 'Tabs')[0]

  clicked(root, (each) => each.kind === 'Button' && each.calls['role']?.[0] === 'link', herdr.cx)

  expect([strip?.calls['overflow_x_scroll'], strip?.calls['flex_wrap']]).toEqual([[], undefined])
  expect(found(root, (each) => each.kind === 'Tab').every((each) => each.calls['flex_none'] !== undefined)).toBe(true)
  expect(labelled(root).filter(([kind]) => kind === 'Button')).toEqual([['Button', 'Log, opens in its own tab']])
  expect(herdr.commands).toEqual([['tab.new', { name: 'Log', mod: 'cmod', props: { show: 'page', session: 'worker', mod: 'demo', id: 'log', title: 'Log' } }]])
})

const tabsOf = (herdr: Herdr) => found(herdr.render(), (each) => each.kind === 'Tab').map((each) => [each.args[0], each.calls['selected']?.[0], each.nodes])

test("the dock of cmod's Herdr mod shows the session's views as its tabs, in the order cmod/UI lists them, shows the first one, and draws every one so a switch shows at once", async () => {
  const herdr = await herdrWith({}, named)

  expect(tabsOf(herdr)).toEqual([
    ['cmod-tab-cmod/dashboard', true, ['Dashboard']],
    ['cmod-tab-demo/runs', false, ['Runs']],
  ])
  expect(herdr.asked.filter(([method]) => ['cmod/UI.views', 'cmod/UI.pages', 'cmod/UI.draw'].includes(method))).toEqual([
    ['cmod/UI.views', ['worker']],
    ['cmod/UI.pages', ['worker']],
    ['cmod/UI.draw', ['worker', { mod: 'cmod', id: 'dashboard' }, { columns: 40, surface: 'herdr' }]],
    ['cmod/UI.draw', ['worker', { mod: 'demo', id: 'runs' }, { columns: 40, surface: 'herdr' }]],
  ])
})

test("the dock of cmod's Herdr mod keeps showing the last Claude Code session's views while a terminal with no session has the focus, and shows a session it showed before at once when it comes back to it", async () => {
  const herdr = await herdrWith({}, named)

  herdr.focus('t3')
  herdr.render()
  await herdr.settled()
  const kept = found(herdr.render(), (each) => each.nodes.includes('worker/cmod/dashboard')).length
  herdr.focus('t2')
  herdr.render()
  await herdr.settled()
  herdr.focus('t1')
  herdr.render()
  await herdr.settled()
  const back = found(herdr.render(), (each) => each.nodes.includes('worker/cmod/dashboard')).length

  expect([kept, back]).toEqual([1, 1])
  expect(calledWith(herdr, 'cmod/UI.views')).toEqual([['worker'], ['other'], ['worker']])
})

test("cmod's Herdr mod keeps text that lays out in cells, block and box-drawing characters or runs of spaces, in the terminal font, and centers a row's buttons on its field", async () => {
  const usageView = {
    $cmodElement: 'Box',
    props: {
      flexDirection: 'column',
      children: [
        { $cmodElement: 'Box', props: { gap: 2, children: [{ $cmodElement: 'Text', props: { children: 'jarvis          ' } }, { $cmodElement: 'Text', props: { color: 'inactive', children: '███' } }] } },
        { $cmodElement: 'Box', props: { columnGap: 2, flexWrap: 'wrap', children: [{ $cmodElement: 'Input', props: { key: 'demo/usage:find', label: 'Find', value: '' } }, { $cmodElement: 'Button', props: { plain: true, key: 'demo/usage:filter', label: 'Show: All', onPress: { $cmodHandler: 3 } } }] } },
      ],
    },
  }
  const herdr = await herdrWith({}, listing(() => usageView, { views: [{ mod: 'demo', id: 'usage', title: 'Usage' }], pages: [] }))
  const drawn = found(herdr.render(), () => true)
  const row = drawn.find((each) => each.nodes.some((node) => node instanceof Element && node.calls['id']?.[0] === 'demo/usage:field:demo/usage:find'))

  expect(drawn.find((each) => each.nodes.includes('███'))?.calls['font_family']).toEqual(['JetBrains Mono'])
  expect(drawn.find((each) => each.nodes.includes('jarvis          '))?.calls['font_family']).toEqual(['JetBrains Mono'])
  expect([row?.calls['items_center'], row?.calls['gap_y']]).toEqual([[], [8]])
})

test("cmod's Herdr mod centers a view that draws one sentence, in the muted color", async () => {
  const herdr = await herdrWith({}, listing(() => ({ $cmodElement: 'Text', props: { dimColor: true, children: 'Run /rulebook to check every Prompt in this project.' } }), { views: [{ mod: 'rulebook', id: 'results', title: 'rulebook' }], pages: [] }))
  const root = herdr.render()
  const body = found(root, (each) => each.calls['id']?.[0] === 'cmod-note')[0]
  const note = found(root, (each) => each.nodes.includes('Run /rulebook to check every Prompt in this project.'))[0]

  expect([body?.calls['items_center'], body?.calls['justify_center']]).toEqual([[], []])
  expect([note?.calls['text_center'], note?.calls['text_color']]).toEqual([[], ['#muted']])
})

test("cmod's Herdr mod draws a mod's page as T3 Code's settings do: tabs in sentence case, a Panel with actions as a header with its title and buttons, a labelled field as a row with its label at the left, and a field with no label across the row", async () => {
  const page = {
    $cmodElement: 'Box',
    props: {
      flexDirection: 'column',
      children: [
        { $cmodElement: 'Input', props: { key: 'demo/page:find', placeholder: 'Find a prompt', value: '' } },
        {
          $cmodElement: 'Panel',
          props: {
            title: 'demo',
            description: '0.2.0 · A demo mod',
            actions: [{ $cmodElement: 'Button', props: { key: 'demo/page:turn', label: 'Turn off', onPress: { $cmodHandler: 1 } } }],
            children: { $cmodElement: 'Panel', props: { title: 'Options', children: { $cmodElement: 'Input', props: { key: 'demo/page:option', label: 'Branch', value: 'main' } } } },
          },
        },
      ],
    },
  }
  const herdr = await herdrWith({}, listing(() => page, { views: [{ mod: 'demo', id: 'page', title: 'rulebook' }], pages: [] }))
  const drawn = found(herdr.render(), () => true)
  const headings = drawn.filter((each) => each.calls['role']?.[0] === 'heading').map((each) => [each.nodes[0], each.calls['text_size']?.[0], each.calls['text_color']?.[0]])
  const fields = drawn.filter((each) => each.kind === 'Input').map((each) => [each.calls['accessibility_label']?.[0], each.calls['w']?.[0], each.calls['w_full']])
  const row = drawn.find((each) => each.calls['id']?.[0] === 'demo/page:field:demo/page:option')

  expect(tabsOf(herdr)).toEqual([['cmod-tab-demo/page', true, ['Rulebook']]])
  expect(headings).toEqual([
    ['demo', 14, '#foreground'],
    ['Options', 12, '#muted'],
  ])
  expect(drawn.some((each) => each.nodes.includes('0.2.0 · A demo mod'))).toBe(true)
  expect(drawn.filter((each) => each.kind === 'Button').map((each) => each.calls['accessibility_label']?.[0])).toContain('Turn off')
  expect(fields).toEqual([
    ['Find a prompt', undefined, []],
    ['Branch', 220, undefined],
  ])
  expect(row?.nodes.filter((node) => node instanceof Element && node.nodes.includes('Branch'))).toHaveLength(1)
})

test("a Redraw draws again only the part it names in cmod's Herdr mod", async () => {
  const widget = (id: string) => ({ mod: 'demo', id, areas: ['dashboard'] })
  const draws = new Map<string, number>()
  const herdr = await herdrWith(
    { show: 'widgets', area: 'dashboard' },
    listing(
      (params) => {
        const { id } = partOf(params)
        draws.set(id, (draws.get(id) ?? 0) + 1)
        return { $cmodElement: 'Text', props: { children: `${id} draw ${draws.get(id)}` } }
      },
      { widgets: [widget('cost'), widget('branch')] },
    ),
  )
  const before = calledWith(herdr, 'cmod/UI.draw').length

  herdr.tell('Redraw', { session: 'worker', mod: 'demo', id: 'branch' })
  await herdr.settled()

  expect(calledWith(herdr, 'cmod/UI.draw').slice(before)).toEqual([['worker', { mod: 'demo', id: 'branch' }, { columns: 40, surface: 'herdr', area: 'dashboard' }]])
  expect(labelled(herdr.render())).toEqual([
    ['div', 'cost draw 1'],
    ['div', 'branch draw 2'],
  ])
})

test("cmod's Herdr mod keeps only the image files its drawings show, and deletes an old one once no drawing shows it", async () => {
  const drawnPath = (text: string) => `/herdr/mods/cmod/.drawn/${hashOf(Buffer.from(text))}.png`
  const leftover = drawnPath('left by an earlier run')
  const pictures = new Map([['cost', 'chart 1'], ['branch', 'chart 1']])
  const herdr = await herdrWith(
    { show: 'widgets', area: 'dashboard' },
    listing((params) => ({ $cmodElement: 'Image', props: { label: 'Chart', columns: 10, rows: 4, source: { png: Buffer.from(pictures.get(partOf(params).id) as string).toString('base64') } } }), {
      widgets: [{ mod: 'demo', id: 'cost', areas: ['dashboard'] }, { mod: 'demo', id: 'branch', areas: ['dashboard'] }],
    }),
    { leftovers: [leftover] },
  )

  expect(herdr.deleted).toEqual([leftover])
  expect([...herdr.written.keys()]).toEqual([drawnPath('chart 1')])

  pictures.set('branch', 'chart 2')
  herdr.tell('Redraw', { session: 'worker', mod: 'demo', id: 'branch' })
  await herdr.settled()

  expect(herdr.deleted).toEqual([leftover])
  expect([...herdr.written.keys()].sort()).toEqual([drawnPath('chart 1'), drawnPath('chart 2')].sort())

  pictures.set('cost', 'chart 2')
  herdr.tell('Redraw', { session: 'worker', mod: 'demo', id: 'cost' })
  await herdr.settled()

  expect(herdr.deleted).toEqual([leftover, drawnPath('chart 1')])
  expect([...herdr.written.keys()]).toEqual([drawnPath('chart 2')])

  await herdr.view.close()

  expect(herdr.deleted).toEqual([leftover, drawnPath('chart 1'), drawnPath('chart 2')])
  expect(herdr.written.size).toBe(0)
})

test("cmod's Herdr mod draws each widget for the area its props name, and leaves out a widget that does not list it", async () => {
  const herdr = await herdrWith({ show: 'widgets', area: 'belowPrompt' }, listing(() => ({ $cmodElement: 'Text', props: { children: 'main' } }), { widgets: [{ mod: 'demo', id: 'branch', areas: ['belowPrompt', 'dashboard'] }, { mod: 'demo', id: 'cost', areas: ['dashboard'] }] }))

  expect(herdr.asked.filter(([method]) => method !== '$/listen')).toEqual([
    ['cmod/UI.widgets', ['worker']],
    ['cmod/UI.draw', ['worker', { mod: 'demo', id: 'branch' }, { columns: 40, surface: 'herdr', area: 'belowPrompt' }]],
  ])
})

test("cmod's Herdr mod opens a page a mod opened as a Herdr tab, closes that tab on Close, and shows a view a mod opened as the dock's tab", async () => {
  const herdr = await herdrWith({}, named)

  herdr.tell('Open', { session: 'worker', mod: 'demo', id: 'log' })
  await herdr.settled()
  herdr.render()
  herdr.tell('Open', { session: 'worker', mod: 'demo', id: 'runs' })
  herdr.tell('Close', { session: 'worker', mod: 'demo', id: 'log' })
  herdr.tell('Open', { session: 'other', mod: 'demo', id: 'log' })
  await herdr.settled()

  expect(herdr.commands).toEqual([
    ['tab.new', { name: 'Log', mod: 'cmod', props: { show: 'page', session: 'worker', mod: 'demo', id: 'log', title: 'Log' } }],
    ['tab.close', { id: 'tab-1' }],
  ])
  expect(tabsOf(herdr).map(([tab, isSelected]) => [tab, isSelected])).toEqual([
    ['cmod-tab-cmod/dashboard', false],
    ['cmod-tab-demo/runs', true],
  ])
  expect(calledWith(herdr, 'cmod/UI.draw').at(-1)).toEqual(['worker', { mod: 'demo', id: 'runs' }, { columns: 40, surface: 'herdr' }])
})

const clientOf = (herdr: Herdr) => (calledWith(herdr, 'cmod/UI.show')[0] as readonly unknown[])[1] as string

test("a window of cmod's Herdr mod tells cmod/UI show the view it shows, as the session's host, tells it again for each tab switch, renews it inside the lease, tells it again when the focused session changes, and clears it when it closes", async () => {
  const herdr = await herdrWith({ show: 'views', overlay: 'o1' }, named)
  const client = clientOf(herdr)

  clicked(herdr.render(), (each) => each.kind === 'Tab' && each.args[0] === 'cmod-tab-demo/runs', herdr.cx)
  await herdr.settled()
  const [renewal] = herdr.timers
  renewal?.[1](herdr.cx)
  await herdr.settled()
  herdr.focus('t2')
  herdr.render()
  await herdr.settled()
  await herdr.view.close()

  expect(client).toMatch(/^herdr-/)
  expect(herdr.timers.map(([ms]) => ms < 16_000)).toEqual([true])
  expect(calledWith(herdr, 'cmod/UI.show')).toEqual([
    ['worker', client, [], { isHost: true }],
    ['worker', client, [{ mod: 'cmod', id: 'dashboard' }], { isHost: true }],
    ['worker', client, [{ mod: 'demo', id: 'runs' }], { isHost: true }],
    ['worker', client, [{ mod: 'demo', id: 'runs' }], { isHost: true }],
    ['worker', client, []],
    ['other', client, [], { isHost: true }],
    ['other', client, [{ mod: 'demo', id: 'runs' }], { isHost: true }],
    ['other', client, []],
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

test("a dock of cmod's Herdr mod in any layout shows its own block for an Open the person asked for, and only for it, while a window changes no layout", async () => {
  const herdr = await herdrWith({ show: 'views' }, named, { tree: panelLayout })
  const window = await herdrWith({ show: 'views', overlay: 'o1' }, named, { tree: panelLayout })

  herdr.tell('Open', { session: 'worker', mod: 'demo', id: 'runs' })
  await herdr.settled()
  const unasked = [...herdr.commands]
  herdr.tell('Open', { session: 'worker', mod: 'cmod', id: 'dashboard', isAsked: true })
  window.tell('Open', { session: 'worker', mod: 'cmod', id: 'dashboard', isAsked: true })
  await Promise.all([herdr.settled(), window.settled()])

  expect(unasked).toEqual([])
  expect(herdr.commands).toEqual([
    ['layout.show', { id: 'side' }],
    ['layout.select', { stack: 'body', child: 'views' }],
  ])
  expect(tabsOf(herdr).map(([tab, isSelected]) => [tab, isSelected])).toEqual([
    ['cmod-tab-cmod/dashboard', true],
    ['cmod-tab-demo/runs', false],
  ])
  expect(window.commands).toEqual([])
})

test("cmod's Herdr mod releases a session's field states only after a frame that no longer draws them", async () => {
  const herdr = await runsShown()
  const note = found(herdr.render(), (each) => each.kind === 'Input')[0]?.args[0]

  herdr.focus('t2')
  herdr.render()
  await herdr.settled()
  herdr.render()
  const releasedBeforeFrameEnds = [...herdr.released]
  herdr.endFrame()

  expect(note).toBeDefined()
  expect(releasedBeforeFrameEnds).not.toContain(note)
  expect(herdr.released).toContain(note)
})

test("cmod's Herdr mod shows why a session shows nothing in place of its views, with Try again, and shows its views with no press once the session's cmod plugin holds it again", async () => {
  const refusal = 'Session worker runs here, but no cmod plugin of 7.0.0 or later in it reaches cmod serve, so its views show only in Claude Code. Run /reload-plugins in it to show them here.'
  let isHeld = false
  const herdr = await herdrWith({}, (method, params) => {
    if (!isHeld) throw new Error(refusal)
    return named(method, params)
  })
  const refused = labelled(herdr.render())

  isHeld = true
  herdr.tell('Change', { session: 'worker', part: 'views' })
  await herdr.settled()

  expect(refused).toEqual([
    ['div', "This session can't show its views here"],
    ['div', refusal],
    ['Button', 'Try again'],
  ])
  expect(found(herdr.render(), (each) => each.nodes.includes('worker/cmod/dashboard'))).toHaveLength(1)
})

test("cmod's Herdr mod redraws the window for no event that changes nothing it shows, as another session's redraw, because every mod redraw redraws Herdr's whole window", async () => {
  const herdr = await herdrWith({}, named)
  const before = herdr.notified()

  herdr.tell('Redraw', { session: 'elsewhere', mod: 'demo', id: 'runs' })
  herdr.tell('Change', { session: 'elsewhere', part: 'views' })
  await herdr.settled()

  expect(herdr.notified()).toBe(before)
})

test("cmod's Herdr mod looks up the focused session again after a failed read, so one failure never leaves it on No session in focus", async () => {
  const herdr = await herdrWith({}, named, { failedSessionReads: 1 })
  const failed = labelled(herdr.render())

  herdr.endFrame()
  herdr.render()
  await herdr.settled()

  expect(failed).toContainEqual(['div', 'No session in focus'])
  expect(found(herdr.render(), (each) => each.nodes.includes('worker/cmod/dashboard'))).toHaveLength(1)
})

test("cmod's Herdr mod says cmod serve isn't reachable when serve.json names none, and connects once Try again finds one", async () => {
  const herdr = await herdrWith({}, named, { isServing: false })

  expect(labelled(herdr.render())).toEqual([
    ['div', "cmod serve isn't reachable"],
    ['div', `cmod serve is not running: ${store}/serve.json does not exist. A Claude Code session with the cmod plugin starts it.`],
    ['Button', 'Try again'],
  ])
})

test("a page tab of cmod's Herdr mod tells cmod/UI show its page, and a widgets block tells nothing and renews nothing", async () => {
  const page = await herdrWith({ show: 'page', session: 'worker', mod: 'demo', id: 'log', title: 'Log' }, named)
  const widgets = await herdrWith({ show: 'widgets', area: 'belowPrompt' }, listing(() => null, { widgets: [{ mod: 'demo', id: 'branch', areas: ['belowPrompt'] }] }))

  widgets.timers[0]?.[1](widgets.cx)
  await widgets.settled()

  expect(calledWith(page, 'cmod/UI.show')).toEqual([['worker', clientOf(page), [{ mod: 'demo', id: 'log' }]]])
  expect(calledWith(widgets, 'cmod/UI.show')).toEqual([])
})

test("a Close of the view the dock of cmod's Herdr mod shows goes back to the first view, as the Sidebar takes a closed view away", async () => {
  const herdr = await herdrWith({}, named)
  clicked(herdr.render(), (each) => each.kind === 'Tab' && each.args[0] === 'cmod-tab-demo/runs', herdr.cx)
  await herdr.settled()

  herdr.tell('Close', { session: 'worker', mod: 'demo', id: 'runs' })
  await herdr.settled()

  expect(tabsOf(herdr).map(([tab, isSelected]) => [tab, isSelected])).toEqual([
    ['cmod-tab-cmod/dashboard', true],
    ['cmod-tab-demo/runs', false],
  ])
  expect(herdr.commands).toEqual([])
})

test("a dropped connection to cmod serve never shows as the view's error: the view keeps its drawing, the bar says it reconnects, and the view draws again once it does", async () => {
  let isHeld = false
  const boxed = listing((params) => ({ $cmodElement: 'Box', props: { children: { $cmodElement: 'Text', props: { children: `${params[0]}/${partOf(params).mod}/${partOf(params).id}` } } } }))
  const herdr = await herdrWith({}, (method, params) => (isHeld && method === 'cmod/UI.draw' ? unanswered : boxed(method, params)))
  isHeld = true
  herdr.tell('Redraw', { session: 'worker', mod: 'cmod', id: 'dashboard' })
  await herdr.settled()

  herdr.drop()
  await herdr.settled()
  const dropped = herdr.render()
  isHeld = false
  herdr.endFrame()
  await herdr.settled()
  const back = herdr.render()

  const alerts = (root: Element) => found(root, (each) => each.calls['role']?.[0] === 'alert').map((each) => each.nodes)
  expect(alerts(dropped)).toEqual([['Reconnecting to cmod serve: WebSocket connection is closed']])
  expect(found(dropped, (each) => each.nodes.includes('worker/cmod/dashboard'))).toHaveLength(1)
  expect(alerts(back)).toEqual([])
  expect(found(back, (each) => each.nodes.includes('worker/cmod/dashboard'))).toHaveLength(1)
})
