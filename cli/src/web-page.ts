/// <reference lib="dom" />

import type { ClosedPage, ElementData, HandlerData, SidebarTab } from '@cmodjs/core/src/runtime/web.js'

export type Group = 'needs' | 'replied' | 'working' | 'idle'

export type AgentRow = {
  readonly id: string
  readonly title: string
  readonly color?: string
  readonly project: string
  readonly group: Group
  readonly reason: string
  readonly at: string
  readonly isUnread: boolean
}

export type FeedItem = { readonly id: string; readonly kind: 'prompt' | 'reply' | 'tool'; readonly text: string }

export type OpenAgent = {
  readonly row: AgentRow
  readonly model: string
  readonly contextPercent?: number
  readonly isWorking: boolean
  readonly state?: string
  readonly waiting?: string
  readonly feed: readonly FeedItem[]
  readonly tabs: readonly SidebarTab[]
  readonly pages: readonly ClosedPage[]
  readonly page?: ElementData
}

export type Screen = {
  readonly rows: readonly AgentRow[]
  readonly cursor?: string
  readonly open?: OpenAgent
  readonly tab: string
  readonly isIdleOpen: boolean
  readonly focus: 'row' | 'prompt'
  readonly sent: number
  readonly notice?: string
}

export type PressInput = { readonly kind: string; readonly key: string; readonly value?: string; readonly href?: string }

export type ScreenActions = {
  move(by: number): void
  open(session: string): void
  done(): void
  unread(): void
  toggleIdle(): void
  showTab(tab: string): void
  closeTab(tab: string): void
  openPage(page: ClosedPage): void
  prompt(text: string): void
  stop(): void
}

export const conversationTab = 'conversation'

export const listColumns = 46

const groupTitles: Readonly<Record<Group, string>> = { needs: 'Needs you', replied: 'Replied', working: 'Working', idle: 'Idle' }

export const groupOrder: readonly Group[] = ['needs', 'replied', 'working', 'idle']

type Children = ElementData | string | readonly (ElementData | string)[]

type BoxProps = {
  readonly key?: string
  readonly flexDirection?: 'row' | 'column'
  readonly flexWrap?: 'wrap'
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly alignItems?: 'flex-start'
  readonly width?: number
  readonly minWidth?: number
  readonly height?: string
  readonly paddingX?: number
  readonly marginBottom?: number
  readonly rowGap?: number
  readonly columnGap?: number
  readonly backgroundColor?: string
  readonly children?: Children
}

type TextProps = {
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly inverse?: boolean
  readonly color?: string
  readonly size?: 'heading'
  readonly wrap?: 'truncate-end'
  readonly children: Children
}

type ButtonProps = {
  readonly key: string
  readonly label?: string
  readonly plain?: boolean
  readonly hotkey?: string
  readonly dimColor?: boolean
  readonly autoFocus?: boolean
  readonly children?: ElementData
  readonly onPress: HandlerData
}

type InputProps = { readonly key: string; readonly rows: number; readonly placeholder: string; readonly submitLabel: string; readonly autoFocus?: boolean; readonly onSubmit: HandlerData }

type MarkdownProps = { readonly key: string; readonly text: string }

function Box(props: BoxProps): ElementData {
  return { $cmodElement: 'Box', props }
}

function Text(props: TextProps): ElementData {
  return { $cmodElement: 'Text', props }
}

function Button(props: ButtonProps): ElementData {
  return { $cmodElement: 'Button', props }
}

function Input(props: InputProps): ElementData {
  return { $cmodElement: 'Input', props }
}

function Markdown(props: MarkdownProps): ElementData {
  return { $cmodElement: 'Markdown', props }
}

export function visibleRows(screen: Pick<Screen, 'rows' | 'cursor' | 'isIdleOpen'>): AgentRow[] {
  return groupOrder.flatMap((group) => screen.rows.filter((row) => row.group === group && (group !== 'idle' || screen.isIdleOpen || row.id === screen.cursor)))
}

export function appScreen(screen: Screen, actions: ScreenActions, on: (run: (input: PressInput) => void) => HandlerData): ElementData {
  const shown = visibleRows(screen)
  const rowOf = (row: AgentRow) => {
    const isCursor = row.id === screen.cursor
    return Button({
      plain: true,
      key: `row:${row.id}`,
      ...(isCursor && screen.focus === 'row' ? { autoFocus: true } : {}),
      onPress: on(() => actions.open(row.id)),
      children: Box({
        flexDirection: 'column',
        paddingX: 1,
        ...(isCursor ? { backgroundColor: 'userMessageBackground' } : {}),
        children: [
          Text({ wrap: 'truncate-end', children: [Text({ color: row.color ?? 'inactive', children: '● ' }), Text({ dimColor: true, children: `${row.project}  ` }), Text({ bold: row.isUnread, children: row.title })] }),
          Text({ wrap: 'truncate-end', dimColor: !row.isUnread && row.group !== 'needs', ...(row.group === 'needs' ? { color: 'warning' } : {}), children: row.reason }),
        ],
      }),
    })
  }
  const groups = groupOrder.flatMap((group) => {
    const all = screen.rows.filter((row) => row.group === group)
    if (all.length === 0) return []
    const heading =
      group === 'idle'
        ? Button({ plain: true, key: 'idle', label: `${screen.isIdleOpen ? '▾' : '▸'} ${groupTitles[group]} ${all.length}`, onPress: on(actions.toggleIdle) })
        : Text({ bold: true, ...(group === 'needs' ? { color: 'warning' } : {}), children: `${groupTitles[group]} ${all.length}` })
    return [Box({ key: `group:${group}`, flexDirection: 'column', marginBottom: 1, children: [heading, ...shown.filter((row) => row.group === group).map(rowOf)] })]
  })
  const keyBar = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    children: [
      Button({ plain: true, key: 'next', hotkey: 'j', label: 'next', onPress: on(() => actions.move(1)) }),
      Button({ plain: true, key: 'previous', hotkey: 'k', label: 'previous', onPress: on(() => actions.move(-1)) }),
      Button({ plain: true, key: 'done', hotkey: 'e', label: 'done', onPress: on(actions.done) }),
      Button({ plain: true, key: 'unread', hotkey: 'u', label: 'unread', onPress: on(actions.unread) }),
      Text({ dimColor: true, children: 'enter: open  esc: list' }),
    ],
  })
  const list = Box({
    key: 'list',
    flexDirection: 'column',
    width: listColumns,
    flexShrink: 0,
    paddingX: 1,
    children: [Box({ flexDirection: 'column', flexGrow: 1, children: groups.length === 0 ? [Text({ dimColor: true, children: 'No Claude Code session runs now. Start one, and it shows here.' })] : groups }), keyBar],
  })
  return Box({ flexDirection: 'row', height: '100%', children: [list, screen.open === undefined ? Box({ flexGrow: 1 }) : openView(screen, screen.open, actions, on)] })
}

function openView(screen: Screen, open: OpenAgent, actions: ScreenActions, on: (run: (input: PressInput) => void) => HandlerData): ElementData {
  const { row } = open
  const facts = [row.project, open.model, open.contextPercent === undefined ? '' : `${Math.round(open.contextPercent)}% context`, open.state ?? groupTitles[row.group]].filter((fact) => fact !== '')
  const tab = (key: string, label: string, isClosable: boolean) => [
    Button({ plain: true, key: `tab:${key}`, label, children: Text({ ...(screen.tab === key ? { bold: true, inverse: true } : { dimColor: true }), children: ` ${label} ` }), onPress: on(() => actions.showTab(key)) }),
    ...(isClosable ? [Button({ plain: true, key: `close:${key}`, label: '×', dimColor: true, onPress: on(() => actions.closeTab(key)) })] : []),
  ]
  const tabs = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    children: [...tab(conversationTab, 'Conversation', false), ...open.tabs.flatMap((each) => tab(each.key, each.label, each.isClosable)), ...open.pages.map((page) => Button({ plain: true, key: `page:${page.mod}/${page.page}`, label: `+ ${page.title}`, dimColor: true, onPress: on(() => actions.openPage(page)) }))],
  })
  const feed = Box({
    key: `feed:${row.id}`,
    flexDirection: 'column',
    flexGrow: 1,
    rowGap: 1,
    children:
      open.feed.length === 0
        ? [Text({ dimColor: true, children: 'No prompt yet.' })]
        : open.feed.map((item) =>
            item.kind === 'prompt'
              ? Box({ key: `message:${item.id}`, paddingX: 1, backgroundColor: 'userMessageBackground', children: Text({ children: `› ${item.text}` }) })
              : item.kind === 'reply'
                ? Markdown({ key: `message:${item.id}`, text: item.text })
                : Text({ dimColor: true, wrap: 'truncate-end', children: `⏺ ${item.text}` }),
          ),
  })
  const page = Box({ key: `page:${row.id}:${screen.tab}`, flexDirection: 'column', flexGrow: 1, children: open.page ?? Text({ dimColor: true, children: 'Drawing…' }) })
  const notices = [...(open.waiting === undefined ? [] : [`${open.waiting.replace(/[.?!]?$/, (end) => end || '.')} Answer it in the session's terminal.`]),...(screen.notice === undefined ? [] : [screen.notice])]
  return Box({
    key: `open:${row.id}`,
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    paddingX: 1,
    rowGap: 1,
    children: [
      Box({ flexDirection: 'column', children: [Text({ size: 'heading', children: row.title }), Text({ dimColor: true, children: facts.join(' · ') })] }),
      tabs,
      screen.tab === conversationTab ? feed : page,
      ...notices.map((text) => Text({ color: 'warning', children: text })),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        alignItems: 'flex-start',
        children: [
          Input({ key: `prompt:${row.id}:${screen.sent}`, rows: 3, placeholder: `Reply to ${row.title}`, submitLabel: 'send', ...(screen.focus === 'prompt' ? { autoFocus: true } : {}), onSubmit: on(({ value }) => actions.prompt(value ?? '')) }),
          ...(open.isWorking ? [Button({ key: 'stop', label: 'Stop', onPress: on(actions.stop) })] : []),
        ],
      }),
    ],
  })
}

const theme = {
  dark: 'color-scheme:dark;--background:#1e1e1e;--text:#ffffff;--inverseText:#000000;--inactive:#999999;--subtle:#505050;--suggestion:#b1b9f9;--remember:#b1b9f9;--success:#4eba65;--error:#ff6b80;--warning:#ffc107;--merged:#af87ff;--claude:#d77757;--permission:#b1b9f9;--planMode:#48968c;--autoAccept:#af87ff;--promptBorder:#888888;--bashBorder:#fd5db1;--ide:#4782c8;--diffAdded:#225c2b;--diffRemoved:#7a2936;--diffAddedDimmed:#47584a;--diffRemovedDimmed:#69484d;--diffAddedWord:#38a660;--diffRemovedWord:#b3596b;--userMessageBackground:#373737',
  light: 'color-scheme:light;--background:#ffffff;--text:#000000;--inverseText:#ffffff;--inactive:#666666;--subtle:#afafaf;--suggestion:#5769f7;--remember:#0000ff;--success:#2c7a39;--error:#ab2b3f;--warning:#966c1e;--merged:#8700ff;--claude:#d77757;--permission:#5769f7;--planMode:#006666;--autoAccept:#8700ff;--promptBorder:#999999;--bashBorder:#ff0087;--ide:#4782c8;--diffAdded:#69db7c;--diffRemoved:#ffa8b4;--diffAddedDimmed:#c7e1cb;--diffRemovedDimmed:#fdd2d8;--diffAddedWord:#2f9d44;--diffRemovedWord:#d1454b;--userMessageBackground:#f0f0f0',
}

const style = `
:root{${theme.dark};--row:18px}
@media (prefers-color-scheme: light){:root{${theme.light}}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--background);color:var(--text);font:13px/var(--row) ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#status{position:fixed;right:1ch;bottom:calc(var(--row)/2);color:var(--inactive)}
#status:empty{display:none}
#app{height:100vh;padding:calc(var(--row)/2) 0}
#probe{position:absolute;visibility:hidden;white-space:pre}
[data-key="list"]{overflow:auto;border-right:1px solid var(--subtle)}
[data-key^="feed:"],[data-key^="page:"]{overflow:auto;min-height:0}
[data-key^="feed:"]>*,[data-key="list"]>.b>*{flex-shrink:0}
[data-key^="open:"]{height:100%}
[data-key^="row:"]{align-self:stretch;width:100%}
[data-key^="row:"]:focus-visible{outline:1px solid var(--claude)}
[data-key^="prompt:"]{flex:1}
@media (max-width:700px){#app>.b{flex-direction:column}[data-key="list"]{width:auto!important;border-right:0}}
.b{display:flex;flex-direction:row;flex-shrink:1;min-width:0;position:relative}
.t{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.t .t{display:inline}
.t.cut{white-space:pre;overflow:hidden;text-overflow:ellipsis}
.t.cut .t{white-space:inherit}
.size-caption{font-size:.8em}.size-footnote{font-size:.85em}.size-heading{font-size:1.15em;font-weight:600}.size-title{font-size:1.3em;font-weight:700}
.bordered::before{content:'';position:absolute;inset:calc(var(--row)/2) .5ch;border:var(--border-width) var(--border-style) var(--border-color);border-radius:var(--border-radius);pointer-events:none}
.button{font:inherit;color:inherit;text-decoration:none;background:none;border:1px solid var(--subtle);border-radius:4px;padding:0 1ch;line-height:calc(var(--row) - 2px);cursor:pointer;text-align:left;align-self:flex-start}
.button.primary{border-color:var(--claude);color:var(--claude)}
.button.plain{border:0;padding:0;line-height:inherit;border-radius:0}
.button.dim{color:color-mix(in srgb,currentColor 55%,transparent)}
.button:hover,.button:focus-visible{background:var(--text);color:var(--background);outline:none}
[data-key^="row:"]:hover,[data-key^="row:"]:focus-visible{background:none;color:inherit}
.hotkey{color:var(--claude)}
.link{color:var(--suggestion)}
.field{display:flex;gap:1ch;align-items:baseline;min-width:0;flex:1}
.label{flex:0 0 auto}
.input,.select{flex:1;min-width:0;font:inherit;color:inherit;background:var(--userMessageBackground);border:1px solid var(--subtle);border-radius:4px;padding:0 .5ch}
textarea.input{resize:vertical}
.hint{display:none;color:var(--inactive)}
.field:focus-within .hint{display:inline}
.code,.raster{margin:0;white-space:pre-wrap;font:inherit}
.code.cut{white-space:pre;overflow:hidden}
.code .gutter{color:var(--inactive)}
.code .added{background:var(--diffAdded)}.code .removed{background:var(--diffRemoved)}.code .hunk{color:var(--inactive)}
.markdown{min-width:0}
.markdown.dim{color:color-mix(in srgb,var(--text) 55%,transparent)}
.markdown>:first-child{margin-top:0}.markdown>:last-child{margin-bottom:0}
.markdown p,.markdown ul,.markdown ol,.markdown blockquote,.markdown table,.markdown pre{margin:0 0 var(--row)}
.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{font:inherit;font-weight:700;margin:0 0 var(--row)}
.markdown ul,.markdown ol{padding-left:3ch}
.markdown blockquote{border-left:1px solid var(--subtle);padding-left:1ch;color:var(--inactive)}
.markdown code{color:var(--permission)}
.markdown table{border-collapse:collapse}.markdown th,.markdown td{border:1px solid var(--subtle);padding:0 1ch}
.markdown hr{border:0;border-top:1px solid var(--subtle)}
.gap{color:var(--warning)}
`

type Frame = { readonly draw: number; readonly html: string }

function client(): void {
  const app = document.getElementById('app') as HTMLElement
  const status = document.getElementById('status') as HTMLElement
  const probe = document.getElementById('probe') as HTMLElement
  const retryMs = [500, 1000, 2000, 4000]
  const steadyRetryMs = 5000
  const reconnectingAfterMs = 5000
  const typedWaitMs = 1000
  const stream = crypto.randomUUID()
  let columns = 0
  let draw = 0
  let reopening = new AbortController()
  let wanted: Element | null = null
  let feed: Element | null = null
  let typedOn: number | undefined
  let typedTimer: ReturnType<typeof setTimeout> | undefined
  const waitingTyped = new Map<string, HTMLInputElement | HTMLTextAreaElement>()
  const sent = new Map<string, string[]>()

  const say = (text: string) => void (status.textContent = text)
  const press = (body: object) => {
    void fetch('/api/press', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream, draw, ...body }) }).then(
      (answer) => {
        if (!answer.ok) say(`cmod web did not take that: ${answer.status}`)
      },
      (error: unknown) => {
        if (!(error instanceof TypeError)) throw error
        say('cmod web did not answer, so that did not reach it.')
      },
    )
  }
  const measure = () => {
    const width = probe.getBoundingClientRect().width / 10
    return width > 0 ? Math.floor(app.clientWidth / width) : 120
  }

  const keyOf = (node: Node) => (node instanceof Element ? node.getAttribute('data-key') : null)
  const isSame = (left: Node, right: Node) => left.nodeType === right.nodeType && left.nodeName === right.nodeName && keyOf(left) === keyOf(right)
  const isField = (node: Element | null): node is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
  const patch = (current: Node, next: Node) => {
    if (!(current instanceof Element) || !(next instanceof Element)) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue
      return
    }
    const drawnBefore = current.getAttribute('data-value')
    for (const { name } of Array.from(current.attributes)) if (!next.hasAttribute(name)) current.removeAttribute(name)
    for (const { name, value } of next.attributes) if (current.getAttribute(name) !== value) current.setAttribute(name, value)
    if (isField(current)) {
      const drawn = next.getAttribute('data-value') ?? ''
      const isFocused = current === document.activeElement
      const isEcho = isFocused && (sent.get(keyOf(current) ?? '') ?? []).includes(drawn)
      if (current instanceof HTMLSelectElement) patchChildren(current, next)
      if ((drawn === drawnBefore && !(current instanceof HTMLSelectElement)) || isEcho) return
      const caret = isFocused && !(current instanceof HTMLSelectElement) ? [current.selectionStart, current.selectionEnd] : undefined
      current.value = drawn
      if (caret !== undefined && !(current instanceof HTMLSelectElement)) current.setSelectionRange(Math.min(caret[0] ?? drawn.length, drawn.length), Math.min(caret[1] ?? drawn.length, drawn.length))
      return
    }
    patchChildren(current, next)
  }
  const patchChildren = (parent: ParentNode, next: ParentNode) => {
    const before = [...parent.childNodes]
    const after = [...next.childNodes]
    after.forEach((node, index) => {
      const old = before[index]
      if (old === undefined) parent.appendChild(node)
      else if (isSame(old, node)) patch(old, node)
      else old.replaceWith(node)
    })
    for (const extra of before.slice(after.length)) extra.remove()
  }
  const drawScreen = (frame: Frame) => {
    draw = frame.draw
    if (typedOn !== undefined && frame.draw > typedOn) setTimeout(flushTyped)
    const shownFeed = app.querySelector('[data-key^="feed:"]')
    const wasAtBottom = shownFeed === null || shownFeed.scrollHeight - shownFeed.scrollTop - shownFeed.clientHeight < 4
    const next = document.createElement('template')
    next.innerHTML = frame.html
    patchChildren(app, next.content)
    for (const canvas of app.querySelectorAll<HTMLCanvasElement>('canvas[data-rgba]')) {
      const bytes = Uint8ClampedArray.from(atob(canvas.getAttribute('data-rgba') ?? ''), (character) => character.charCodeAt(0))
      if (bytes.length === canvas.width * canvas.height * 4) canvas.getContext('2d')?.putImageData(new ImageData(bytes, canvas.width, canvas.height), 0, 0)
    }
    const nowFeed = app.querySelector('[data-key^="feed:"]')
    if (nowFeed !== null && (nowFeed !== feed || wasAtBottom)) nowFeed.scrollTop = nowFeed.scrollHeight
    feed = nowFeed
    const asked = app.querySelector('[autofocus]')
    if (asked === wanted) return
    wanted = asked
    const focused = document.activeElement
    if (asked instanceof HTMLElement && !(isField(focused) && focused !== asked)) asked.focus()
  }

  const flushTyped = () => {
    typedOn = undefined
    clearTimeout(typedTimer)
    const fields = [...waitingTyped.values()]
    waitingTyped.clear()
    for (const field of fields) input(field, 'change', field.getAttribute('data-input'), { value: field.value })
  }
  const input = (element: Element, kind: 'press' | 'change' | 'submit' | 'select' | 'link', handler: string | null, extra: { value?: string; href?: string } = {}) => {
    if (handler === null) return
    const key = element.getAttribute('data-key') ?? ''
    if (kind === 'change' && typedOn !== undefined && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return void waitingTyped.set(key, element)
    if (kind === 'change') {
      typedOn = draw
      typedTimer = setTimeout(flushTyped, typedWaitMs)
    } else if (waitingTyped.size > 0) {
      flushTyped()
    }
    if (extra.value !== undefined) sent.set(key, [...(sent.get(key) ?? []), extra.value].slice(-20))
    press({ handler: Number(handler), key, kind, ...extra })
  }
  app.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const link = target?.closest('a[data-link]')
    if (link instanceof HTMLAnchorElement) {
      event.preventDefault()
      return input(link.closest('[data-key]') ?? link, 'link', link.getAttribute('data-link'), { href: link.getAttribute('href') ?? '' })
    }
    const pressed = target?.closest('[data-press]')
    if (pressed !== null && pressed !== undefined) input(pressed, 'press', pressed.getAttribute('data-press'))
  })
  app.addEventListener('input', (event) => {
    const field = event.target
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.hasAttribute('data-input')) input(field, 'change', field.getAttribute('data-input'), { value: field.value })
  })
  app.addEventListener('keydown', (event) => {
    const field = event.target
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return
    event.preventDefault()
    input(field, 'submit', field.getAttribute('data-submit'), { value: field.value })
  })
  app.addEventListener('change', (event) => {
    const field = event.target
    if (field instanceof HTMLSelectElement) input(field, 'select', field.getAttribute('data-select'), { value: field.value })
  })
  document.addEventListener('keydown', (event) => {
    const focused = document.activeElement
    if (event.key === 'Escape' && isField(focused)) {
      event.preventDefault()
      focused.blur()
      const asked = app.querySelector('[autofocus]')
      if (asked instanceof HTMLElement && asked !== focused) asked.focus()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isField(focused)) return
    const key = event.key.toLowerCase()
    if (!/^[0-9a-z]$/.test(key)) return
    const pressed = [...app.querySelectorAll<HTMLElement>('button[data-hotkey]')].findLast((each) => each.getAttribute('data-hotkey') === key)
    if (pressed === undefined) return
    event.preventDefault()
    pressed.click()
  })

  const readStream = async (signal: AbortSignal, onOpen: () => void) => {
    columns = measure()
    const answer = await fetch(`/api/stream?${new URLSearchParams({ stream, columns: String(columns) })}`, { signal })
    if (!answer.ok || answer.body === null) throw new TypeError(`cmod web answered ${answer.status}.`)
    onOpen()
    const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffered = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += value
      for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
        const lines = buffered.slice(0, end).split('\n')
        buffered = buffered.slice(end + 2)
        const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length)
        if (lines.includes('event: screen') && data !== undefined) drawScreen(JSON.parse(data) as Frame)
      }
    }
  }
  const follow = async () => {
    let failures = 0
    let downSince: number | undefined
    for (;;) {
      reopening = new AbortController()
      try {
        await readStream(reopening.signal, () => {
          failures = 0
          downSince = undefined
          say('')
        })
      } catch (error) {
        if (reopening.signal.aborted) continue
        if (!(error instanceof TypeError)) throw error
      }
      downSince ??= Date.now()
      if (Date.now() - downSince >= reconnectingAfterMs) say('Reconnecting to cmod web…')
      await new Promise((resolve) => setTimeout(resolve, retryMs[failures] ?? steadyRetryMs))
      failures += 1
    }
  }

  let resizing: ReturnType<typeof setTimeout> | undefined
  new ResizeObserver(() => {
    clearTimeout(resizing)
    resizing = setTimeout(() => {
      if (measure() !== columns) reopening.abort()
    }, 150)
  }).observe(app)
  void follow()
}

export function webPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>cmod</title><style>${style}</style></head><body><div id="app"></div><div id="status"></div><span id="probe">0000000000</span><script nonce="${nonce}">(${client.toString()})()</script></body></html>`
}
