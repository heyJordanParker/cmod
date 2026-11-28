import { expect, test } from 'bun:test'
import { parsePreferences, parseWebUi } from '../../src/records.js'
import { htmlOf } from '../../src/runtime/web.js'
import { Badge, Banner, Dialog, Help, List, ListItem, Pagination, Panel, Progress, Split, Tabs, Toggle, Tooltip } from '../../src/ui/components.js'
import { Box, Button, Code, elementData, Image, Input, Markdown, Raster, Select, Svg, Text, type Handler } from '../../src/ui/elements.js'

const drawn = (element: unknown) => {
  const handlers: Handler[] = []
  return { html: htmlOf(elementData(element, (run) => handlers.push(run) - 1)), handlers }
}

test('a Box draws as a flex box in cells, its Text in the theme colors, and a key the browser keeps across redraws', () => {
  const { html } = drawn(Box({ key: 'row', flexDirection: 'column', gap: 1, paddingX: 2, width: 30, children: [Text({ bold: true, color: 'claude', children: 'CI' }), Text({ dimColor: true, wrap: 'truncate-end', children: 'main' })] }))

  expect(html).toBe(
    '<div class="b s0" data-key="row" style="flex-direction:column;column-gap:1ch;row-gap:calc(1 * var(--row));width:30ch;padding-right:2ch;padding-left:2ch"><span class="t" style="color:var(--claude);font-weight:700">CI</span><span class="t cut" style="color:color-mix(in srgb, var(--text) 55%, transparent)">main</span></div>',
  )
})

test("a Button carries the number of the handler elementData kept for its onPress and the hotkey the browser presses it with, and a plain one draws its hotkey as the terminal does", () => {
  const pressed: string[] = []
  const { html, handlers } = drawn(Box({ children: [Button({ key: 'save', label: 'Save', variant: 'primary', hotkey: 's', onPress: () => void pressed.push('save') }), Button({ plain: true, hotkey: 'n', label: 'Next', onPress: () => void pressed.push('next') })] }))
  handlers[1]?.()

  expect(html).toBe('<div class="b"><button type="button" class="button primary" data-key="save" data-press="0" data-hotkey="s">Save</button><button type="button" class="button plain" data-key="Next" data-press="1" data-hotkey="n"><span class="hotkey">n</span>: Next</button></div>')
  expect(pressed).toEqual(['next'])
})

test('a Button that JSX draws with no children, as children: [], draws its label', () => {
  const html = htmlOf({ $cmodElement: 'Button', props: { variant: 'primary', key: 'ci/runs:open', label: 'Open', onPress: { $cmodHandler: 4 }, children: [] } })

  expect(html).toBe('<button type="button" class="button primary" data-key="ci/runs:open" data-press="4">Open</button>')
})

test('a hover lights only while the pointer rests on its nearest keyed Box, and a named scope lights each of its elements together', () => {
  const { html } = drawn(
    Box({
      key: 'page',
      children: [
        Box({ key: 'row', children: Text({ hover: { bold: true }, children: 'Row' }) }),
        Text({ hover: { underline: true, scope: 'runs' }, children: 'Run 7' }),
        Button({ label: 'Open', onPress: () => undefined, hover: { color: 'claude', scope: 'runs' } }),
      ],
    }),
  )

  expect(html).toBe(
    '<style>.s1:hover .h0,.s1.h0:hover{font-weight:700 !important}:root:has(.g0:hover) .h1{text-decoration:underline !important}:root:has(.g0:hover) .h2{color:var(--claude) !important}</style>' +
      '<div class="b s0" data-key="page"><div class="b s1" data-key="row"><span class="t h0">Row</span></div><span class="t h1 g0">Run 7</span><button type="button" class="button h2 g0" data-key="Open" data-press="0">Open</button></div>',
  )
})

test('a Box drawn hidden with a hover that shows it reveals while its keyed Box is hovered, as a Tooltip card does', () => {
  const { html } = drawn(Box({ key: 'tip', children: [Text({ children: 'run 7' }), Box({ display: 'none', position: 'absolute', top: 1, hover: { display: 'flex' }, children: Text({ children: 'The last run' }) })] }))

  expect(html).toBe(
    '<style>.s0:hover .h0,.s0.h0:hover{display:flex !important}</style><div class="b s0" data-key="tip"><span class="t">run 7</span><div class="b h0" style="display:none;position:absolute;top:calc(1 * var(--row))"><span class="t">The last run</span></div></div>',
  )
})

test('a Button with children draws them in place of its label, and its label names it', () => {
  const { html } = drawn(Button({ key: 'run-7', label: 'Open run 7', onPress: () => undefined, children: ['Run 7 ', Text({ dimColor: true, children: '2m' })] }))

  expect(html).toBe('<button type="button" class="button" aria-label="Open run 7" data-key="run-7" data-press="0">Run 7 <span class="t" style="color:color-mix(in srgb, var(--text) 55%, transparent)">2m</span></button>')
})

test('a Panel draws as a section headed by its title, with its actions beside the title and its description under it', () => {
  const { html } = drawn(Panel({ title: 'Runs', children: Text({ children: 'passed' }) }))
  const headed = drawn(Panel({ title: 'demo', description: '0.2.0', actions: [Button({ key: 'turn', label: 'Turn off', onPress: () => undefined })] })).html

  expect(html).toBe('<section class="panel"><header class="panel-header"><h3 class="panel-title">Runs</h3></header><div class="panel-body"><span class="t">passed</span></div></section>')
  expect(headed).toContain('<header class="panel-header"><h3 class="panel-title">demo</h3><div class="actions"><button type="button"')
  expect(headed).toContain('Turn off</button></div></header><p class="panel-description">0.2.0</p>')
})

test('text a mod draws never becomes markup, and a style or color it names is dropped unless it is one the browser draws', () => {
  const { html } = drawn(Text({ color: 'red;background:url(x)', backgroundColor: '#ff0000', children: '<script>alert(1)</script>' }))

  expect(html).toBe('<span class="t" style="background:#ff0000">&#60;script&#62;alert(1)&#60;/script&#62;</span>')
})

test('a Button with an href opens only an http, https, mailto, or file link, in a new tab, drawn as a button', () => {
  expect(drawn(Button({ plain: true, key: 'docs', href: 'https://example.com', label: 'docs' })).html).toBe('<a class="button plain" href="https://example.com" target="_blank" rel="noopener noreferrer" data-key="docs">docs</a>')
  expect(drawn(Button({ key: 'run', href: 'javascript:alert(1)', label: 'run' })).html).toBe('<button type="button" class="button" data-key="run">run</button>')
})

test('a Link from a mod on an older @cmodjs/core still opens in a new tab', () => {
  expect(htmlOf({ $cmodElement: 'Link', props: { href: 'https://example.com', label: 'docs' } })).toBe('<a class="link" href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>')
})

test('an Input keeps its value, its handlers, and its submit label, and rows above 1 draw a textarea', () => {
  const { html } = drawn(Box({ flexDirection: 'column', children: [Input({ key: 'name', label: 'Name', value: 'Ada', submitLabel: 'save', onInput: () => undefined, onSubmit: () => undefined }), Input({ key: 'note', rows: 3, onSubmit: () => undefined })] }))

  expect(html).toContain('<label class="field"><span class="label">Name</span><input type="text" class="input" data-key="name" data-input="0" data-submit="1" data-value="Ada" value="Ada"><span class="hint">enter: save</span></label>')
  expect(html).toContain('<textarea class="input" rows="3" data-key="note" data-submit="2"></textarea>')
})

test('a Select draws its options with the drawn one selected', () => {
  const { html } = drawn(Select({ key: 'branch', label: 'Branch', value: 'dev', options: [{ value: 'main' }, { value: 'dev', label: 'Development' }], onSelect: () => undefined }))

  expect(html).toBe('<label class="field"><span class="label">Branch</span><select class="select" data-key="branch" data-select="0" data-value="dev"><option value="main">main</option><option value="dev" selected>Development</option></select></label>')
})

test('Markdown draws as HTML, and a link its onLinkPress answers carries that handler instead of opening', () => {
  const { html } = drawn(Markdown({ key: 'notes', text: '# Notes\n\n- [x] **ship** it\n- see [the run](https://ci.example/1)\n\n```ts\nconst a = 1\n```', onLinkPress: () => undefined }))

  expect(html).toBe('<div class="markdown" data-key="notes"><h1>Notes</h1><ul><li>☑ <p><strong>ship</strong> it</p></li><li><p>see <a class="link" href="https://ci.example/1" data-link="0">the run</a></p></li></ul><pre class="code"><span class="line">const a = 1</span></pre></div>')
})

test('Code numbers its lines from startLine, and a diff marks the lines it adds and removes', () => {
  expect(drawn(Code({ source: 'a\nb', startLine: 9 })).html).toBe('<pre class="code"><span class="line"><span class="gutter"> 9 </span>a</span>\n<span class="line"><span class="gutter">10 </span>b</span></pre>')
  expect(drawn(Code({ source: '@@ -1 +1 @@\n-a\n+b', format: 'diff' })).html).toBe('<pre class="code"><span class="line hunk">@@ -1 +1 @@</span>\n<span class="line removed">-a</span>\n<span class="line added">+b</span></pre>')
})

test('an Svg, a PNG Image, and an Image of raw pixels draw as images named by their label, and an Image from a file draws its label', () => {
  expect(drawn(Image({ source: { rgba: 'AAAA/w==', width: 1, height: 1 }, columns: 2, rows: 1, label: 'a dot' })).html).toBe('<canvas class="image" width="1" height="1" data-rgba="AAAA/w==" aria-label="a dot" style="width:2ch;height:calc(1 * var(--row))"></canvas>')
  expect(drawn(Svg({ source: '<svg/>', label: 'a dot', width: 20 })).html).toBe('<img class="svg" alt="a dot" src="data:image/svg+xml,%3Csvg%2F%3E" style="width:20px">')
  expect(drawn(Image({ source: { png: 'iVBORw0KGgo=' }, columns: 4, rows: 2, label: 'logo' })).html).toBe('<img class="image" alt="logo" src="data:image/png;base64,iVBORw0KGgo=" style="width:4ch;height:calc(2 * var(--row))">')
  expect(drawn(Image({ source: { file: '/tmp/a.png', format: 'png' }, columns: 4, rows: 2, label: 'logo' } as never)).html).toBe('<span class="t dim" style="width:4ch;height:calc(2 * var(--row))">logo</span>')
})

test("a released core's Image and Svg, which name their picture with alt, keep that name in the browser", () => {
  expect(htmlOf({ $cmodElement: 'Image', props: { source: { png: 'iVBORw0KGgo=' }, columns: 4, rows: 2, alt: 'logo' } })).toBe('<img class="image" alt="logo" src="data:image/png;base64,iVBORw0KGgo=" style="width:4ch;height:calc(2 * var(--row))">')
  expect(htmlOf({ $cmodElement: 'Svg', props: { source: '<svg/>', alt: 'a dot' } })).toBe('<img class="svg" alt="a dot" src="data:image/svg+xml,%3Csvg%2F%3E">')
})

test('a Button that shows only an icon takes its label as its accessible name', () => {
  expect(drawn(Button({ key: 'close', label: 'Close the run', onPress: () => undefined, children: Text({ children: '×' }) })).html).toBe('<button type="button" class="button" aria-label="Close the run" data-key="close" data-press="0"><span class="t">×</span></button>')
})

test('a Raster draws each cell as its glyph in its colors, one row per line, as one image named by its label', () => {
  const words = Uint32Array.of(0x2588, 0xff8800, 0x01000000, 0x41, 0x01000000, 0x000000)
  const cells = btoa(String.fromCharCode(...new Uint8Array(words.buffer)))

  expect(drawn(Raster({ key: 'grid', columns: 1, rows: 2, cells, label: 'the build grid' })).html).toBe('<pre class="raster" role="img" aria-label="the build grid"><span style="color:#ff8800">█</span>\n<span style="background:#000000">A</span></pre>')
})

test('an element this cmod web does not know draws a note naming it, so a newer cmod plugin never breaks an older server', () => {
  expect(htmlOf({ $cmodElement: 'Hologram', props: {} })).toBe('<span class="gap">The browser draws no Hologram.</span>')
})

test('every component of ui/components.js draws in the browser as its own HTML control, each with the handler it runs', () => {
  const { html, handlers } = drawn(
    Box({
      flexDirection: 'column',
      children: [
        Tabs({ tabs: [{ key: 'runs', label: 'Runs', hotkey: 'r' }, { key: 'logs', label: 'Logs', hotkey: 'l' }], selected: 'runs', onSelect: () => undefined, children: Text({ children: 'run 7' }) }),
        Split({ children: [Text({ children: 'left' }), Text({ children: 'right' })] }),
        Panel({ title: 'Changed files', children: Text({ children: 'src/a.ts' }) }),
        Toggle({ label: 'Follow', checked: true, onChange: () => undefined }),
        Tooltip({ text: 'The last run', children: Text({ children: 'run 7' }) }),
        Help({ text: 'Press r to rerun', isOpen: false, onOpenChange: () => undefined }),
        Dialog({ title: 'Delete the branch?', actions: [Button({ variant: 'primary', autoFocus: true, label: 'Keep it', onPress: () => undefined })], children: Text({ children: 'Its commits go.' }) }),
        Pagination({ page: 1, pages: 3, onPage: () => undefined }),
        Progress({ value: 50, width: 4, label: 'Context used' }),
        List({ label: 'Mods', children: [ListItem({ key: 'mod:demo', label: 'demo', tone: 'warning', isSelected: true }), ListItem({ key: 'mod:old', label: 'old', tone: 'off', onPress: () => undefined })] }),
        List({ label: 'Runs', children: [ListItem({ key: 'run:1', leading: 'Bash', label: 'bun test', depth: 1, isOpen: false, onOpenChange: () => undefined, trailing: Badge({ tone: 'critical', children: 'failed' }), onPress: () => undefined })] }),
        Badge({ tone: 'warning', children: 'warning' }),
        Banner({ tone: 'critical', title: 'Off', children: 'Claude Code does not load it.' }),
      ],
    }),
  )

  expect(html).not.toContain('class="gap"')
  expect(html).toContain('<div role="tablist" class="tablist"><button type="button" role="tab" class="tab" aria-selected="true" data-key="tab:runs" data-press="0" data-hotkey="r">Runs</button><button type="button" role="tab" class="tab" aria-selected="false" data-key="tab:logs" data-press="1" data-hotkey="l">Logs</button></div><div role="tabpanel" class="tabpanel"><span class="t">run 7</span></div>')
  expect(html).toContain('<div class="split"><div class="split-part"><span class="t">left</span></div><div class="split-part"><span class="t">right</span></div></div>')
  expect(html).toContain('<h3 class="panel-title">Changed files</h3>')
  expect(html).toContain('<button type="button" role="switch" class="switch" aria-checked="true" data-key="toggle:Follow" data-press="2"><span class="switch-track"></span>Follow</button>')
  expect(html).toContain('<span class="tooltip" title="The last run"><span class="t">run 7</span></span>')
  expect(html).toContain('<button type="button" class="help-button" aria-label="Help" aria-expanded="false" title="Press r to rerun" data-press="3">?</button>')
  expect(html).toContain('<div role="dialog" class="dialog" aria-label="Delete the branch?"><h3 class="dialog-title">Delete the branch?</h3>')
  expect(html).toContain('data-press="4" autofocus>Keep it</button>')
  expect(html).toContain('<nav class="pagination" aria-label="Pages"><button type="button" class="button" disabled>Previous</button><span class="t">1 of 3</span><button type="button" class="button" data-press="5" data-hotkey="n">Next</button></nav>')
  expect(html).toContain('<progress class="progress" max="100" value="50" aria-label="Context used" style="width:4ch"></progress>')
  expect(html).toContain('<ul class="list" aria-label="Mods"><li class="list-row" aria-current="true"><span class="list-item selected"><span class="dot tone-warning" aria-hidden="true"></span><span class="item-label">demo</span></span></li><li class="list-row"><button type="button" class="list-item" data-key="mod:old" data-press="6"><span class="dot tone-off" aria-hidden="true"></span><span class="item-label">old</span></button></li></ul>')
  expect(html).toContain('<ul class="list" aria-label="Runs"><li class="list-row tree-row" style="--depth:1" aria-level="2"><button type="button" class="opener" aria-label="Open" aria-expanded="false" data-key="run:1:toggle" data-press="8"></button><button type="button" class="list-item" data-key="run:1" data-press="7"><span class="leading">Bash</span><span class="item-label">bun test</span><span class="trailing"><span class="badge tone-critical">failed</span></span></button></li></ul>')
  expect(html).toContain('<span class="badge tone-warning">warning</span>')
  expect(html).toContain('<div role="status" class="banner tone-critical"><strong class="banner-title">Off</strong><div class="banner-body">Claude Code does not load it.</div></div>')
  expect(handlers).toHaveLength(9)
})

test('a Progress with sections draws in the browser as one meter whose sections fill their share in their tones', () => {
  const { html } = drawn(Progress({ sections: [{ value: 40 }, { value: 15, tone: 'warning' }], width: 20, label: 'Week used' }))

  expect(html).toBe('<div class="progress-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="55" aria-label="Week used" style="width:20ch"><span class="progress-section" style="width:40%"></span><span class="progress-section tone-warning" style="width:15%"></span></div>')
})

test('a Progress section given a Claude Code color fills in that color', () => {
  const { html } = drawn(Progress({ sections: [{ value: 50, tone: 'critical' }, { value: 45, color: 'diffRemoved' }], buffer: 50, width: 20 }))

  expect(html).toBe('<div class="progress-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="95" style="width:20ch"><span class="progress-section tone-critical" style="width:50%"></span><span class="progress-section" style="width:45%;background:var(--diffRemoved)"></span></div>')
})

test('a Progress with a buffer draws the part between its fill and its buffer as raised track', () => {
  const { html } = drawn(Progress({ sections: [{ value: 33, tone: 'neutral' }], buffer: 50, width: 20, label: 'Week used' }))

  expect(html).toBe('<div class="progress-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="33" aria-label="Week used" style="width:20ch"><span class="progress-section tone-neutral" style="width:33%"></span><span class="progress-buffer" style="width:17%"></span></div>')
})

test('a tone a mod names that is not one of the tones draws as neutral, so no text reaches a class', () => {
  expect(htmlOf({ $cmodElement: 'Badge', props: { tone: '"><script>', children: 'x' } })).toBe('<span class="badge tone-neutral">x</span>')
})

test("web.json holds the web UI's port, and preferences.json says whether the person wants it", () => {
  expect(parseWebUi({ port: 4567 }, 'web.json')).toEqual({ port: 4567 })
  expect(parseWebUi(undefined, 'web.json')).toBeUndefined()
  expect(() => parseWebUi({ port: '4567' }, 'web.json')).toThrow("web.json is not the web UI's port. Delete it, and cmod web serve writes it again.")
  expect(parsePreferences({ servesWebUi: true }, 'preferences.json')).toEqual({ showsInstalledModErrors: false, servesWebUi: true, servesTailnet: true, servesApi: false, runsAgentsAsSessions: false, roundsBarEnds: false })
  expect(() => parsePreferences({ servesWebUi: 'yes' }, 'preferences.json')).toThrow("preferences.json is not a map of cmod's preferences to true or false.")
})

test('web apps are on the tailnet unless the person turned servesTailnet off', () => {
  expect(parsePreferences(undefined, 'preferences.json').servesTailnet).toBe(true)
  expect(parsePreferences({ servesTailnet: false }, 'preferences.json').servesTailnet).toBe(false)
  expect(() => parsePreferences({ servesTailnet: 'no' }, 'preferences.json')).toThrow("preferences.json is not a map of cmod's preferences to true or false.")
})
