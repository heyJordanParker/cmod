export type Cmod = {
  call(input: { to: string; method: string; input: unknown }): Promise<unknown>
}

declare module 'claude-code' {
  interface EngineInterface {
    cmod: Cmod
  }
  interface CmodDependencies {}
  interface CmodInterfaces {
    'cmod/Terminal': {
      methods: {
        screen(session: string): string
        press(session: string, keys: string): void
        show(session: string, place: 'focus' | 'peek' | 'tab' | 'right' | 'down' | 'hide'): void
      }
    }
  }
}
