export type TracerSignature = { name: string; line: number }

export type Tracer = {
  signatures(input: { path: string }): Promise<TracerSignature[]>
}

declare module 'claude-code' {
  interface CmodDependencies {
    tracer: Tracer
  }
}
