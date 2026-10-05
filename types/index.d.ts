export type Cmod = {
  call(input: { to: string; method: string; input: unknown }): Promise<unknown>
}

declare module 'claude-code' {
  interface EngineInterface {
    cmod: Cmod
  }
}
