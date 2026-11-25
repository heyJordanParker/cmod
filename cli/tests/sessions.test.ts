import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { connectRpc, type RpcClient } from '@cmodjs/core/src/runtime/rpc.js'
import { stoppedClock } from '@cmodjs/core/src/testing/fake-serve.js'
import { cmodWith, deleteTemporaryHomes, serveChanges, spawningTestLimitMs, startCmod, startOf, temporaryHome, writeFiles } from './cmod.js'

setDefaultTimeout(spawningTestLimitMs)
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
  const waiting: { readonly session: string; readonly count: number; readonly resolve: () => void }[] = []
  const actedOn = (session: string) => acted.filter((each) => each[0] === session).length
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
        for (const each of waiting.filter((wait) => actedOn(wait.session) >= wait.count)) each.resolve()
        return answers[action]?.(input) ?? null
      },
      clock: stoppedClock,
    })
    clients.push(plugin)
    await plugin.request('$/hold', { session, project: home, cwd: home })
  }
  const actedTimes = (session: string, count: number) => new Promise<void>((resolve) => (actedOn(session) >= count ? resolve() : waiting.push({ session, count, resolve })))
  return { home, acted, actedTimes, stop: () => serving.child.kill() }
}

test.concurrent('cmod sessions send, stop, end, compact, and delete reach the cmod plugin that holds the session, a send from inside Claude Code names that session as its sender, and read mail lists each mail with its state', async () => {
  const { home, acted, actedTimes, stop } = await servedSessions({
    worker: {},
    planner: {},
    stalled: {
      send: () => {
        throw new Error('Claude Code dropped the prompt: the session is closing')
      },
    },
  })
  await writeFiles(home, { [`.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/old.jsonl`]: `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'old', timestamp: '2026-11-20T10:00:00.000Z', cwd: home, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } })}\n` })
  const nextMailChange = await serveChanges(home).listen('cmod/Sessions', { session: 'worker', part: 'mail' })

  const fromOutside = await cmodWith(home, outside, 'sessions', 'send', 'worker', 'Rerun the deploy')
  const fromPlanner = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'send', 'worker', 'Tests pass.', '--note')
  const answered = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'send', 'worker', 'Merged.', '--reply-to', '1')
  const queued = await cmodWith(home, outside, 'sessions', 'send', 'stalled', 'Go on')
  await actedTimes('stalled', 1)
  for (let change = 0; change < 6; change += 1) await nextMailChange()
  const mail = await cmodWith(home, outside, 'sessions', 'read', 'mail', 'worker')
  const stopped = await cmodWith(home, outside, 'sessions', 'stop', 'worker')
  const ended = await cmodWith(home, outside, 'sessions', 'end', 'worker')
  const compacted = await cmodWith(home, outside, 'sessions', 'compact', 'worker', '--keep', 'the parser plan')
  const compactedHere = await cmodWith(home, { CLAUDE_CODE_SESSION_ID: 'planner' }, 'sessions', 'compact')
  const running = await cmodWith(home, outside, 'sessions', 'delete', 'worker')
  const deleted = await cmodWith(home, outside, 'sessions', 'delete', 'old')
  stop()

  expect([fromOutside, fromPlanner, answered, queued, stopped, ended, compacted, compactedHere, running, deleted]).toEqual([
    { exitCode: 0, stdout: 'Sent message 1 to session worker. It arrives as soon as the session can take it, and cmod sessions read mail worker shows when.\n', stderr: '' },
    { exitCode: 0, stdout: 'Sent message 2 to session worker. It arrives as soon as the session can take it, and cmod sessions read mail worker shows when.\n', stderr: '' },
    { exitCode: 0, stdout: 'Sent message 3 to session worker. It arrives as soon as the session can take it, and cmod sessions read mail worker shows when.\n', stderr: '' },
    { exitCode: 0, stdout: 'Sent message 4 to session stalled. It arrives as soon as the session can take it, and cmod sessions read mail stalled shows when.\n', stderr: '' },
    { exitCode: 0, stdout: 'Stopped the turn of session worker.\n', stderr: '' },
    { exitCode: 0, stdout: 'Session worker ends once its turn ends.\n', stderr: '' },
    { exitCode: 0, stdout: 'Session worker compacts once its turn ends, and then carries on.\n', stderr: '' },
    { exitCode: 0, stdout: 'Session planner compacts once its turn ends, and then carries on.\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'cmod sessions: session worker runs, so it stays. End it first.\n' },
    { exitCode: 0, stdout: 'Deleted session old.\n', stderr: '' },
  ])
  expect([mail.exitCode, mail.stderr, mail.stdout.trimEnd().split('\n').map((line) => line.slice('2026-11-25 10:00  '.length))]).toEqual([
    0,
    '',
    ['1  delivered  from outside a session to worker  prompt  Rerun the deploy', '2  delivered  from planner to worker  note  Tests pass.', '3  delivered  from planner to worker  prompt  Merged.'],
  ])
  expect(acted).toEqual([
    ['worker', 'send', { type: 'prompt', text: 'Rerun the deploy' }],
    ['worker', 'send', { type: 'note', text: '<cmod-message from="planner" title="" reply="cmod sessions send planner --reply-to 2">\nTests pass.\n</cmod-message>' }],
    ['worker', 'send', { type: 'prompt', text: '<cmod-message from="planner" title="" reply="cmod sessions send planner --reply-to 3" reply-to="1">\nMerged.\n</cmod-message>' }],
    ['stalled', 'send', { type: 'prompt', text: 'Go on' }],
    ['worker', 'abort', {}],
    ['worker', 'end', null],
    ['worker', 'compact', { keep: 'the parser plan' }],
    ['planner', 'compact', {}],
  ])
})

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
})

test.concurrent('cmod sessions list names the device each session runs on and whether it runs, and read messages starts each line with the message id', async () => {
  const { home, stop } = await servedSessions({ worker: {} })
  const project = join(home, 'work/app')
  const transcript = (session: string, title: string, at: string) =>
    [
      { type: 'user', uuid: `${session}-u1`, sessionId: session, timestamp: at, cwd: home, origin: { kind: 'human' }, message: { role: 'user', content: 'Rename the tree pane' } },
      { type: 'custom-title', customTitle: title, sessionId: session },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join('')
  await writeFiles(home, {
    [`.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/worker.jsonl`]: transcript('worker', 'Tree pane rename', '2026-11-25T10:00:00.000Z').replace('worker-u1', 'u1'),
  })
  const device = JSON.parse((await cmodWith(home, outside, 'device', '--json')).stdout) as { readonly name: string }

  const listed = await cmodWith(home, { ...outside, TZ: 'UTC' }, 'sessions', 'list')
  const read = await cmodWith(home, { ...outside, TZ: 'UTC' }, 'sessions', 'read', 'messages', 'worker')
  stop()

  expect(project).toStartWith(home)
  expect(listed).toEqual({ exitCode: 0, stdout: `2026-11-25 10:00  worker  Tree pane rename  running  on ${device.name}\n`, stderr: '' })
  expect(read).toEqual({ exitCode: 0, stdout: '10:00  u1  person   Rename the tree pane\n', stderr: '' })
})

test.concurrent('cmod sessions takes any unique start of a session id, refuses an ambiguous one by naming each match, and a send names the session it reached', async () => {
  const maintainer = '345d8519-d589-441b-947d-8f4fe33a0768'
  const fork = '345dfd97-1c2b-4d3e-8f40-516273849a0b'
  const { home, acted, actedTimes, stop } = await servedSessions({ [maintainer]: {}, [fork]: {} })
  const transcript = (session: string, title: string, at: string) =>
    [
      { type: 'user', uuid: `${session}-u1`, sessionId: session, timestamp: at, cwd: home, origin: { kind: 'human' }, message: { role: 'user', content: 'Port the parser' } },
      { type: 'custom-title', customTitle: title, sessionId: session },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join('')
  const folder = `.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}`
  await writeFiles(home, { [`${folder}/${maintainer}.jsonl`]: transcript(maintainer, 'php#', '2026-11-25T10:00:00.000Z'), [`${folder}/${fork}.jsonl`]: transcript(fork, 'php# fork', '2026-11-25T11:00:00.000Z') })
  const device = JSON.parse((await cmodWith(home, outside, 'device', '--json')).stdout) as { readonly name: string }

  const sent = await cmodWith(home, outside, 'sessions', 'send', '345d85', 'Rerun the deploy')
  const ambiguous = await cmodWith(home, { ...outside, TZ: 'UTC' }, 'sessions', 'send', '345d', 'Rerun the deploy')
  const missing = await cmodWith(home, outside, 'sessions', 'send', 'abcdef12', 'Rerun the deploy')
  await actedTimes(maintainer, 1)
  stop()

  expect(sent).toEqual({ exitCode: 0, stdout: 'Sent message 1 to session 345d8519 (php#). It arrives as soon as the session can take it, and cmod sessions read mail 345d8519 shows when.\n', stderr: '' })
  expect(ambiguous).toEqual({ exitCode: 1, stdout: '', stderr: `cmod sessions: 2 sessions start with 345d. Give more of the id:\n2026-11-25 11:00  ${fork}  php# fork  running  on ${device.name}\n2026-11-25 10:00  ${maintainer}  php#  running  on ${device.name}\n` })
  expect(missing).toEqual({ exitCode: 1, stdout: '', stderr: 'cmod sessions: no session id starts with abcdef12. cmod sessions list --every-project lists the sessions.\n' })
  expect(acted).toEqual([[maintainer, 'send', { type: 'prompt', text: 'Rerun the deploy' }]])
})

test.concurrent('a session Claude Code records as running before cmod indexed any transcript of it is listed with every project, and its id start reaches it', async () => {
  const started = 'b2349836-f62a-4c0c-9168-42dfcd23b400'
  const { home, acted, actedTimes, stop } = await servedSessions({ [started]: {} })
  await writeFiles(home, { '.claude/sessions/1.json': JSON.stringify({ pid: process.pid, sessionId: started, cwd: home, procStart: await startOf(process.pid), name: 'Upgrade', status: 'busy', startedAt: Date.parse('2026-11-25T10:00:00.000Z') }) })

  const listed = await cmodWith(home, outside, 'sessions', 'list', '--every-project', '--json')
  const sent = await cmodWith(home, outside, 'sessions', 'send', 'b2349836', 'Rerun the deploy')
  await actedTimes(started, 1)
  stop()

  expect([listed.exitCode, listed.stderr, (JSON.parse(listed.stdout) as readonly { readonly id: string; readonly title: string; readonly cwd: string; readonly startedAt: string; readonly isRunning: boolean; readonly status?: string }[]).map(({ id, title, cwd, startedAt, isRunning, status }) => ({ id, title, cwd, startedAt, isRunning, status }))]).toEqual([0, '', [{ id: started, title: 'Upgrade', cwd: home, startedAt: '2026-11-25T10:00:00.000Z', isRunning: true, status: 'busy' }]])
  expect(sent).toEqual({ exitCode: 0, stdout: 'Sent message 1 to session b2349836 (Upgrade). It arrives as soon as the session can take it, and cmod sessions read mail b2349836 shows when.\n', stderr: '' })
  expect(acted).toEqual([[started, 'send', { type: 'prompt', text: 'Rerun the deploy' }]])
})

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
})

test.concurrent('cmod sessions names the fix when no cmod serve answers', async () => {
  const home = await temporaryHome()

  const sent = await cmodWith(home, outside, 'sessions', 'send', 'worker', 'Rerun the deploy')

  expect(sent.exitCode).toBe(1)
  expect(sent.stderr).toStartWith(`cmod sessions: cmod sessions reaches no cmod serve at ${join(home, '.local/share/cmod/serve.sock')}: `)
  expect(sent.stderr).toEndWith('. A Claude Code session with the cmod plugin starts it.\n')
})

test.concurrent("cmod sessions names Claude Code's sandbox settings when the process may not open cmod serve's socket", async () => {
  const home = await temporaryHome()
  const socket = join(home, '.local/share/cmod/serve.sock')
  await mkdir(join(home, '.local/share/cmod'), { recursive: true })
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  await chmod(socket, 0o000)

  const listed = await cmodWith(home, outside, 'sessions', 'list')
  server.close()

  expect(listed.exitCode).toBe(1)
  expect(listed.stderr).toMatch(new RegExp(`^cmod sessions: cmod sessions may not open cmod serve's socket ${socket} \\((EACCES|EPERM)\\)\\. In Claude Code's sandbox, list the socket in sandbox\\.network\\.allowUnixSockets on macOS, turn on sandbox\\.network\\.allowAllUnixSockets on Linux, or list cmod in sandbox\\.excludedCommands\\.\n$`))
})
