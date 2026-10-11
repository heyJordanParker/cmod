import type { Message, Session } from '../history.js'
import type { HistoryRequest } from '../runtime/history.js'

export type FakeHistory = { readonly sessions?: readonly Session[]; readonly messages?: readonly Message[] }

export function fakeHistory({ sessions = [], messages = [] }: FakeHistory): (request: HistoryRequest) => readonly Session[] | readonly Message[] {
  const projectOf = new Map(sessions.map((session) => [session.id, session.project]))
  const isInScope = (session: string, request: { readonly project: string; readonly everyProject?: boolean }) => request.everyProject === true || projectOf.get(session) === request.project
  return (request) => {
    if (request.command === 'sessions') {
      return sessions.filter((session) => isInScope(session.id, request) && session.lastAt >= (request.since ?? '')).toSorted((first, second) => second.lastAt.localeCompare(first.lastAt))
    }
    if (request.command === 'search') {
      const text = request.text.toLowerCase()
      const contains = (message: Message) => [message.text, ...message.tools.map((tool) => JSON.stringify(tool.input))].some((each) => each.toLowerCase().includes(text))
      return messages.filter((message) => isInScope(message.session, request) && message.at >= (request.since ?? '') && contains(message)).toSorted((first, second) => second.at.localeCompare(first.at))
    }
    const conversation = messages.filter((message) => message.session === request.session && message.agent === request.agent)
    const start = request.after === undefined ? 0 : conversation.findIndex((message) => message.id === request.after) + 1
    const rest = start === 0 && request.after !== undefined ? [] : conversation.slice(start)
    return request.last === undefined ? rest.slice(0, request.limit) : rest.slice(-request.last)
  }
}
