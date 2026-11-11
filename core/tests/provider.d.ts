export type Signature = { name: string; line: number }

export type Provider = {
  signatures(input: { path: string }): Promise<Signature[]>
}

declare module 'claude-code' {
  interface CmodDependencies {
    provider: Provider
  }
}
