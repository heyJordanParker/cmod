export type Cmod = {
  call(input: { to: string; method: string; input: unknown }): Promise<unknown>
}

declare module 'claude-code' {
  interface EngineInterface {
    cmod: Cmod
  }
  interface CmodDependencies {}
  interface CmodInterfaces {
    'cmod/Sessions': {
      methods: {
        sessions(scope?: { project?: string; everyProject?: boolean; running?: boolean; since?: string }): { id: string; title: string; color?: string; project: string; cwd: string; model: string; startedAt: string; lastAt: string; forkedFrom?: string; isRunning: boolean; agentType?: string; visitedAt?: string; device?: { id: string; name: string }; status?: 'busy' | 'shell' | 'idle' | 'waiting'; waitingFor?: { dialog: string; tool?: string; input?: Record<string, unknown>; question?: string }; contextPercent?: number; lastTurn?: { reason: 'answered' | 'stopped' | 'failed'; at: string; failure?: string } }[]
        search(text: string, options?: { project?: string; everyProject?: boolean; running?: boolean; since?: string; limit?: number; before?: { session: string; id: string }; record?: { session?: string; task?: string; turn?: string; context?: number; isAgent?: true } }): unknown[]
        read(session: string, part: 'messages' | 'turns' | 'contexts' | 'tasks' | 'goal' | 'usage' | 'state', options?: { project?: string; task?: string; turn?: string; context?: number; after?: string; last?: number; all?: true }): unknown
        send(session: string, message: { type: 'prompt' | 'note'; text: string; as?: 'person' | 'session' }, context?: { project?: string; caller?: string; task?: string }): void
        abort(session: string, input: { turn?: string } | null, context?: { project?: string; caller?: string; task?: string }): void
        end(session: string, input: null, context?: { project?: string; caller?: string }): void
        fork(session: string, task: { prompt: string; title: string; isBackground?: boolean; at?: string }, context?: { project?: string; caller?: string }): { id: string; title: string; openedBy: string; openedAt: string; forkedFrom?: string; isBackground?: true }
        startTask(session: string, task: { prompt: string; title: string; agentType?: string; model?: string; name?: string; cwd?: string; isBackground?: boolean; device?: string }, context?: { project?: string; caller?: string }): { id: string; title: string; openedBy: string; openedAt: string; agentType?: string; model?: string; isBackground?: true }
        callTool(session: string, call: { name: string; input: Record<string, unknown> }, context?: { project?: string; caller?: string }): unknown
        usage(session: string, input: null, context?: { project?: string; caller?: string; task?: string }): { model: string; contextWindow: { tokenCount?: number; size?: number; percent?: number } }
        surfaces(session: string, input: null, context?: { project?: string; caller?: string; task?: string }): ('terminal' | 'desktop' | 'mobile' | 'vscode')[]
        visit(session: string, at?: string): void
        delete(session: string, input?: null, context?: { project?: string; caller?: string }): void
      }
      events: { Change: { readonly session: string; readonly part: 'visit' | 'running' | 'tasks' | 'goal' | 'status' | 'deleted' } }
    }
    'cmod/Devices': {
      methods: {
        devices(): { id: string; name: string; address?: string }[]
        send(device: string, message: unknown): void
      }
      events: { Change: { readonly device: string }; Message: { readonly device: string; readonly message: unknown } }
    }
    'cmod/Terminal': {
      methods: {
        screen(session: string): string
        press(session: string, keys: string): void
        show(session: string, place: 'focus' | 'peek' | 'tab' | 'right' | 'down' | 'hide'): void
      }
      events: { Shown: { readonly session: string; readonly place: 'focus' | 'peek' | 'tab' | 'right' | 'down' | 'hide' }; Pressed: { readonly session: string } }
    }
    'cmod/UI': {
      methods: {
        widgets(session: string): { mod: string; id: string; areas: ('abovePrompt' | 'belowPrompt' | 'working' | 'turnEnd' | 'dashboard')[] }[]
        views(session: string): { mod: string; id: string; title: string }[]
        pages(session: string): { mod: string; id: string; title: string }[]
        draw(session: string, part: { mod: string; id: string }, at: { columns: number; surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' | 'browser' | 'herdr' }): unknown
        press(session: string, handler: number, input: { surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' | 'browser' | 'herdr'; key?: string; value?: string; kind?: 'change' | 'submit'; link?: { href: string } }): void
        open(session: string, part: { mod: string; id: string }): void
        close(session: string, part: { mod: string; id: string }): void
        show(session: string, client: string, parts: { mod: string; id: string }[], options?: { isHost?: boolean }): void
      }
      events: { Change: { readonly session: string; readonly part: 'widgets' | 'views' | 'pages' }; Redraw: { readonly session: string; readonly mod: string; readonly id: string }; Open: { readonly session: string; readonly mod: string; readonly id: string; readonly isAsked?: true }; Close: { readonly session: string; readonly mod: string; readonly id: string } }
    }
  }
}
