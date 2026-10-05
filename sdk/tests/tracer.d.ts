export type TracerSignature = { name: string; line: number }

export type Tracer = {
  signatures(input: { path: string }): Promise<TracerSignature[]>
}

declare module 'cmod-sdk/mod.js' {
  interface Dependencies {
    tracer: Tracer
  }
}
