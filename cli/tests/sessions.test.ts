import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { connectRpc, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { cmodWith, deleteTemporaryHomes, startCmod, temporaryHome, writeFiles } from './cmod.js'

const clients: RpcClient[] = []

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close()
  await deleteTemporaryHomes()
})

type Acted = readonly [session: string, action: string, input: unknown]

type Answers = Readonly<Record<string, (input: unknown) => unknown>>

const outside = { CLAUDE_CODE_SESSION_ID: '' }

async function servedSessions(held: Readonly<Record<string, Answers>>) {
  const home = await temporaryHome()
  const serving = startCmod(home, 'serve')
  expect(await serving.firstLine()).toBe(`unix:${join(home, '.local/share/cmod/serve.sock')}`)
  const socket = join(home, '.local/share/cmod/serve.sock')
  const acted: Acted[] = []
  for (const [session, answers] of Object.entries(held)) {
    const plugin = connectRpc({
      call: async (path, init) => {
        const answer = await fetch(`http://localhost${path}`, { method: init.method, ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }), unix: socket } as RequestInit)
        return { status: answer.status, text: await answer.text() }
      },
      handle: async (method, params) => {
        if (method !== '$/act') throw new Error(`The fake cmod plugin answers no ${method}.`)
        const { action, input } = params as { readonly action: string; readonly input: unknown }
        acted.push([session, action, input])
        return answers[action]?.(input) ?? null
      },
      wait: () => new Promise<void>(() => undefined),
    })
    clients.push(plugin)
    await plugin.request('$/hold', { session, project: home, cwd: home })
  }
  return { home, acted, stop: () => serving.child.kill() }
}

test.concurrent('cmod sessions send, stop, end, compact, and delete reach the cmod plugin that holds the session, and a send from inside Claude Code goes from that session, or straight to the session when that cmod plugin is older', async () => {
  const { home, acted, stop } = await servedSessions({ worker: {}, planner: {}, elder: { sendTo: () => { throw new Error('cmod takes no action named sendTo.') } } })
  await writeFiles(home, { [`.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/old.jsonl`]: `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'old', timestamp: '2026-11-20T10:00:00.000Z', cwd: home, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } })}\n` })

  const fromOutside = await cmodWith(home, outside, 'sessions', 'send', 'worker', 'Rerun the deploy')
  const fromPlanner = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'send', 'worker', 'Tests pass.', '--note')
  const fromElder = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'elder' }, 'sessions', 'send', 'worker', 'Merged.')
  const stopped = await cmodWith(home, outside, 'sessions', 'stop', 'worker')
  const ended = await cmodWith(home, outside, 'sessions', 'end', 'worker')
  const compacted = await cmodWith(home, outside, 'sessions', 'compact', 'worker', '--keep', 'the parser plan')
  const compactedHere = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'compact')
  const running = await cmodWith(home, outside, 'sessions', 'delete', 'worker')
  const deleted = await cmodWith(home, outside, 'sessions', 'delete', 'old')
  stop()

  expect([fromOutside, fromPlanner, fromElder, stopped, ended, compacted, compactedHere, running, deleted]).toEqual([
    { exitCode: 0, stdout: 'Sent session worker the prompt.\n', stderr: '' },
    { exitCode: 0, stdout: 'Sent session worker the note.\n', stderr: '' },
    { exitCode: 0, stdout: 'Sent session worker the prompt.\n', stderr: '' },
    { exitCode: 0, stdout: 'Stopped the turn of session worker.\n', stderr: '' },
    { exitCode: 0, stdout: 'Session worker ends once its turn ends.\n', stderr: '' },
    { exitCode: 0, stdout: 'Session worker compacts once its turn ends, and then carries on.\n', stderr: '' },
    { exitCode: 0, stdout: 'Session planner compacts once its turn ends, and then carries on.\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'cmod sessions: session worker runs, so it stays. End it first.\n' },
    { exitCode: 0, stdout: 'Deleted session old.\n', stderr: '' },
  ])
  expect(acted).toEqual([
    ['worker', 'send', { type: 'prompt', text: 'Rerun the deploy' }],
    ['planner', 'sendTo', { type: 'note', text: 'Tests pass.', to: 'worker' }],
    ['elder', 'sendTo', { type: 'prompt', text: 'Merged.', to: 'worker' }],
    ['worker', 'send', { type: 'prompt', text: 'Merged.' }],
    ['worker', 'abort', {}],
    ['worker', 'end', null],
    ['worker', 'compact', { keep: 'the parser plan' }],
    ['planner', 'compact', {}],
  ])
}, 60_000)

test.concurrent('cmod sessions start starts a background task of this session, and fork one on a copy of the session it names, through the plugin that holds it', async () => {
  const task = (id: string) => (input: unknown) => ({ id, title: (input as { readonly title: string }).title, owner: 'planner', openedBy: 'planner', openedAt: '2026-11-25T10:00:00.000Z', isBackground: true })
  const { home, acted, stop } = await servedSessions({ planner: { startBackgroundTask: task('bg-1') }, worker: { fork: task('bg-2') } })

  const started = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'start', 'Upgrade every dependency.', '--title', 'Upgrade', '--model', 'sonnet', '--device', 'devbox')
  const forked = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'fork', 'Try the other parser.', '--title', 'Other parser', '--session', 'worker', '--at', 'm3')
  const outsideStart = await cmodWith(home, outside, 'sessions', 'start', 'Upgrade.', '--title', 'Upgrade')
  const untitled = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'start', 'Upgrade.')
  stop()

  expect([started, forked]).toEqual([
    { exitCode: 0, stdout: 'bg-1  Upgrade\n', stderr: '' },
    { exitCode: 0, stdout: 'bg-2  Other parser\n', stderr: '' },
  ])
  expect([outsideStart.exitCode, outsideStart.stderr]).toEqual([1, 'cmod sessions: cmod sessions start runs inside Claude Code, which names the session the task belongs to in CLAUDE_CODE_SESSION_ID.\n'])
  expect([untitled.exitCode, untitled.stderr]).toEqual([1, 'cmod sessions: cmod sessions start takes --title <title>, a few words that name the task.\n'])
  expect(acted).toEqual([
    ['planner', 'startBackgroundTask', { prompt: 'Upgrade every dependency.', title: 'Upgrade', isBackground: true, model: 'sonnet', device: 'devbox' }],
    ['worker', 'fork', { prompt: 'Try the other parser.', title: 'Other parser', isBackground: true, at: 'm3' }],
  ])
}, 60_000)

test.concurrent('cmod sessions list names the device each session runs on and whether it runs, and read messages starts each line with the message id', async () => {
  const { home, stop } = await servedSessions({ worker: {} })
  const project = join(home, 'work/app')
  await writeFiles(home, {
    [`.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/worker.jsonl`]: [
      { type: 'user', uuid: 'u1', sessionId: 'worker', timestamp: '2026-11-25T10:00:00.000Z', cwd: home, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } },
      { type: 'custom-title', customTitle: 'Tree pane rename', sessionId: 'worker' },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join(''),
  })
  const device = JSON.parse((await cmodWith(home, outside, 'device', '--json')).stdout) as { readonly name: string }

  const listed = await cmodWith(home, { ...outside, TZ: 'UTC' }, 'sessions', 'list')
  const read = await cmodWith(home, { ...outside, TZ: 'UTC' }, 'sessions', 'read', 'messages', 'worker')
  stop()

  expect(project).toStartWith(home)
  expect(listed).toEqual({ exitCode: 0, stdout: `2026-11-25 10:00  worker  Tree pane rename  running  on ${device.name}\n`, stderr: '' })
  expect(read).toEqual({ exitCode: 0, stdout: '10:00  u1  person   Rename the tree pane\n', stderr: '' })
}, 60_000)

test.concurrent("cmod terminal reads, types into, and shows a session's terminal through the program that provides cmod/Terminal", async () => {
  const { home, stop } = await servedSessions({})
  await writeFiles(home, {
    'terminal.ts': [
      "import { provide } from '@cmodjs/core/mod.js'",
      'const typed: string[] = []',
      "provide('cmod/Terminal', { screen: async (session: string) => `${session} screen, typed ${JSON.stringify(typed)}`, press: async (_session: string, keys: string) => void typed.push(keys), show: async () => undefined })",
      "console.log('provided')",
      'await new Promise(() => undefined)',
    ].join('\n'),
  })
  const provider = startCmod(home, 'run', 'terminal.ts')
  expect(await provider.firstLine()).toBe('provided')

  const pressed = await cmodWith(home, outside, 'terminal', 'press', 'worker', '1\\r')
  const screen = await cmodWith(home, outside, 'terminal', 'screen', 'worker')
  const shown = await cmodWith(home, outside, 'terminal', 'show', 'worker', 'peek')
  const misplaced = await cmodWith(home, outside, 'terminal', 'show', 'worker', 'sideways')
  provider.child.kill()
  stop()

  expect([pressed, screen, shown]).toEqual([
    { exitCode: 0, stdout: 'Typed the keys into session worker.\n', stderr: '' },
    { exitCode: 0, stdout: 'worker screen, typed ["1\\r"]\n', stderr: '' },
    { exitCode: 0, stdout: 'Showed the terminal of session worker (peek).\n', stderr: '' },
  ])
  expect([misplaced.exitCode, misplaced.stderr]).toEqual([1, 'cmod terminal: cmod terminal show takes focus, peek, tab, right, down, hide, not sideways.\n'])
}, 60_000)

test.concurrent('cmod sessions names the fix when no cmod serve answers', async () => {
  const home = await temporaryHome()

  const sent = await cmodWith(home, outside, 'sessions', 'send', 'worker', 'Rerun the deploy')

  expect(sent.exitCode).toBe(1)
  expect(sent.stderr).toStartWith(`cmod sessions: cmod sessions reaches no cmod serve at ${join(home, '.local/share/cmod/serve.sock')}: `)
  expect(sent.stderr).toEndWith('. A Claude Code session with the cmod plugin starts it.\n')
}, 60_000)
