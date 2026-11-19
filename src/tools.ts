import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'
import { commands, messageOf, Note, Prompt, providers, Session, sessions, type InterfaceProvider, type Message, type Mod, type Session as SessionOf } from '../node_modules/@cmodjs/core/mod.js'
import { engineOf } from '../node_modules/@cmodjs/core/runtime/engine.js'
import { searchText } from '../node_modules/@cmodjs/core/session/context/turn/message/message.js'
import { firstLine } from '../node_modules/@cmodjs/core/utils/text.js'
import type { CmodPluginState } from './mod.js'

const carryOn = 'The conversation was compacted. Carry on with the work from before the compaction.'

const shownMessages = 30

const foundMessages = 20

const lineChars = 300

const sessionId = { type: 'string', description: 'The id of the session, as list_sessions names it.' } as const

const oneLine = (text: string) => {
  const line = firstLine(text)
  return line.length > lineChars ? `${line.slice(0, lineChars)}…` : line
}

const sessionLine = (session: SessionOf) =>
  [`${session.id}  ${session.isRunning ? 'running' : 'ended'}  ${session.title || '(untitled)'}`, `  project ${session.project}, last active ${session.lastAt}`, ...(session.forkedFrom === undefined ? [] : [`  forked from ${session.forkedFrom}`]), ...(session.visitedAt === undefined ? [] : [`  visited ${session.visitedAt}`])].join('\n')

const places = ['focus', 'peek', 'tab', 'right', 'down', 'hide'] as const

const onTerminal = async <Value>(session: string, run: (terminal: InterfaceProvider<'cmod/Terminal'>) => Promise<Value>): Promise<Value> => {
  const found = await providers('cmod/Terminal')
  const refused: string[] = []
  for (const terminal of found) {
    try {
      return await run(terminal)
    } catch (error) {
      refused.push(`${terminal.mod}: ${messageOf(error)}`)
    }
  }
  throw new Error(found.length === 0 ? `no program on this computer provides cmod/Terminal, so the terminal of session ${session} is out of reach. A session claude --bg started has none.` : `no terminal runs session ${session}. ${refused.join(' ')}`)
}

const messageLine = (message: Message) => `${message.id}  ${message.at}  ${message.type}${message.task === undefined ? '' : ` in task ${message.task}`}: ${oneLine(searchText(message))}`

export function addClaudeTools(mod: Mod<CmodPluginState>): void {
  const { report } = engineOf(mod)
  let compaction: { readonly keep?: string } | undefined

  const compact = async ({ keep }: { readonly keep?: string }) => {
    try {
      await commands.run('compact', keep)
      await sessions.current.send({ type: Prompt, text: carryOn })
    } catch (error) {
      report({ id: 'compact', message: 'Could not compact the conversation', error })
    }
  }

  sessions.current.onTurnEnd(() => {
    const asked = compaction
    compaction = undefined
    if (asked !== undefined) mod.after(1, () => void compact(asked))
  })

  mod.use(
    tool({
      name: 'compact',
      description: 'Compact this conversation once your answer ends: a summary replaces the conversation so far, and a prompt then lets you carry on. Use it when the context window is filling up and the work so far fits in a summary.',
      inputSchema: {
        type: 'object',
        properties: { keep: { type: 'string', description: 'What the summary must keep, such as the plan, the decisions, and the files changed.' } },
        additionalProperties: false,
      },
      execute: ({ keep }) => {
        compaction = keep === undefined ? {} : { keep }
        return 'The conversation compacts once this answer ends, and a prompt then lets you carry on. End your answer now.'
      },
    }),
  )
  mod.use(
    tool({
      name: 'start_session',
      description: 'Start a new background Claude Code session on a task. It works on its own, sees none of this conversation, and keeps running after this session ends. Its end shows up in this session as a task.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Everything the session needs to do the task, because it sees none of this conversation.' },
          title: { type: 'string', description: 'A few words that name the task.' },
          agentType: { type: 'string', description: 'The agent definition the session runs, such as Explore. Leave it out for a plain session.' },
          model: { type: 'string', description: 'The model the session runs on, such as sonnet. Leave it out for the default model.' },
          cwd: { type: 'string', description: 'The folder the session works in. Leave it out for this session’s folder.' },
          machine: { type: 'string', description: 'The machine the session runs on, which a mod that starts sessions on other machines reads. Leave it out for this computer.' },
        },
        required: ['prompt', 'title'],
        additionalProperties: false,
      },
      execute: async ({ prompt, title, agentType, model, cwd, machine }) => {
        const started = await sessions.current.startTask({ prompt, title, isBackground: true, ...(agentType === undefined ? {} : { agentType }), ...(model === undefined ? {} : { model }), ...(cwd === undefined ? {} : { cwd }), ...(machine === undefined ? {} : { machine }) })
        return `Started session ${started.id}. It answers there, not in this conversation. Read it with read_session.`
      },
    }),
  )
  mod.use(
    tool({
      name: 'list_sessions',
      description: "List Claude Code sessions, newest first: this project's, or every project's, on every machine cmod reaches.",
      inputSchema: {
        type: 'object',
        properties: {
          everyProject: { type: 'boolean', description: 'List every project’s sessions, not only this project’s.' },
          running: { type: 'boolean', description: 'List only the sessions that run now.' },
          since: { type: 'string', description: 'List only sessions active since this ISO time.' },
        },
        additionalProperties: false,
      },
      execute: async ({ everyProject, running, since }) => {
        const found = await sessions.list({ ...(everyProject === undefined ? {} : { everyProject }), ...(running === undefined ? {} : { running }), ...(since === undefined ? {} : { since }) })
        return found.length === 0 ? 'No sessions.' : found.map(sessionLine).join('\n')
      },
    }),
  )
  mod.use(
    tool({
      name: 'search_sessions',
      description: 'Search the messages of Claude Code sessions for a text, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to find, at least 3 characters.' },
          everyProject: { type: 'boolean', description: 'Search every project’s sessions, not only this project’s.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async ({ text, everyProject }) => {
        const found: Message[] = []
        for await (const message of sessions.search(text, undefined, everyProject === undefined ? {} : { everyProject })) {
          found.push(message)
          if (found.length === foundMessages) break
        }
        return found.length === 0 ? `No message holds "${text}".` : found.map((message) => `${message.session}  ${messageLine(message)}`).join('\n')
      },
    }),
  )
  mod.use(
    tool({
      name: 'read_session',
      description: "Read a session's latest messages, each with the id fork_session takes as at.",
      inputSchema: {
        type: 'object',
        properties: { session: sessionId, last: { type: 'number', description: `How many of the latest messages to read. ${shownMessages} when left out.` } },
        required: ['session'],
        additionalProperties: false,
      },
      execute: async ({ session, last }) => {
        const read = await sessions.get(session)
        const messages = await read.messages({ last: last ?? shownMessages })
        return [sessionLine(read), ...messages.map(messageLine)].join('\n')
      },
    }),
  )
  mod.use(
    tool({
      name: 'message_session',
      description: 'Send a session a prompt, which it answers as its next turn, or a note, which it reads with its next prompt. A session that ended resumes on the prompt.',
      inputSchema: {
        type: 'object',
        properties: { session: sessionId, text: { type: 'string', description: 'The message.' }, isNote: { type: 'boolean', description: 'Send it as a note the session reads with its next prompt, not as a prompt.' } },
        required: ['session', 'text'],
        additionalProperties: false,
      },
      execute: async ({ session, text, isNote }) => {
        await (await sessions.get(session)).send({ type: isNote === true ? Note : Prompt, text, as: Session })
        return `Sent session ${session} the ${isNote === true ? 'note' : 'prompt'}.`
      },
    }),
  )
  mod.use(
    tool({
      name: 'stop_session',
      description: "Stop a session's running turn, as Esc does in its terminal. The session keeps running and takes the next prompt.",
      inputSchema: { type: 'object', properties: { session: sessionId }, required: ['session'], additionalProperties: false },
      execute: async ({ session }) => {
        const turn = await (await sessions.get(session)).turn()
        if (turn === undefined) return `Session ${session} runs no turn.`
        await turn.abort()
        return `Stopped the turn of session ${session}.`
      },
    }),
  )
  mod.use(
    tool({
      name: 'end_session',
      description: 'End a session’s Claude Code once its running turn ends. Its conversation stays, and message_session resumes it.',
      inputSchema: { type: 'object', properties: { session: sessionId }, required: ['session'], additionalProperties: false },
      execute: async ({ session }) => {
        await (await sessions.get(session)).end()
        return `Session ${session} ends once its turn ends.`
      },
    }),
  )
  mod.use(
    tool({
      name: 'fork_session',
      description: "Start a background session on a copy of a session's conversation, up to a message or whole, and give it a task.",
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'The session to fork, as list_sessions names it. Leave it out for this session.' },
          prompt: { type: 'string', description: 'The task the fork works on.' },
          title: { type: 'string', description: 'A few words that name the task.' },
          at: { type: 'string', description: 'The id of the last message the fork keeps, from read_session. Leave it out to keep the whole conversation.' },
        },
        required: ['prompt', 'title'],
        additionalProperties: false,
      },
      execute: async ({ session, prompt, title, at }) => {
        const source = session === undefined ? sessions.current : await sessions.get(session)
        const fork = await source.fork({ prompt, title, isBackground: true, ...(at === undefined ? {} : { at }) })
        return `Forked session ${source.id} into session ${fork.id}.`
      },
    }),
  )
  mod.use(
    tool({
      name: 'read_screen',
      description: "Read the screen of a session's terminal, as the person sees it.",
      inputSchema: { type: 'object', properties: { session: sessionId }, required: ['session'], additionalProperties: false },
      execute: ({ session }) => onTerminal(session, (terminal) => terminal.screen(session)),
    }),
  )
  mod.use(
    tool({
      name: 'press_keys',
      description: "Type keys into a session's terminal, as the person would, such as an answer to a dialog.",
      inputSchema: { type: 'object', properties: { session: sessionId, keys: { type: 'string', description: 'The keys to type, such as 1 then Enter for the first answer: "1\\r".' } }, required: ['session', 'keys'], additionalProperties: false },
      execute: async ({ session, keys }) => {
        await onTerminal(session, (terminal) => terminal.press(session, keys))
        return `Typed the keys into session ${session}.`
      },
    }),
  )
  mod.use(
    tool({
      name: 'show_session',
      description: "Show a session's terminal in a pane of the app that runs it on this computer: focused, as a peek, as a tab, right of or below the focused pane, or hidden again. You keep working in your own pane.",
      inputSchema: { type: 'object', properties: { session: sessionId, place: { type: 'string', enum: [...places], description: 'Where the terminal shows. focus when left out.' } }, required: ['session'], additionalProperties: false },
      execute: async ({ session, place }) => {
        const where = places.find((each) => each === place) ?? 'focus'
        await onTerminal(session, (terminal) => terminal.show(session, where))
        return where === 'hide' ? `Hid the terminal of session ${session}.` : `Showed the terminal of session ${session} (${where}).`
      },
    }),
  )
  mod.use(
    tool({
      name: 'delete_session',
      description: 'Delete a session that has ended: its transcripts, goal, tasks, and index rows. A running session stays.',
      inputSchema: { type: 'object', properties: { session: sessionId }, required: ['session'], additionalProperties: false },
      execute: async ({ session }) => {
        await (await sessions.get(session)).delete()
        return `Deleted session ${session}.`
      },
    }),
  )
}
