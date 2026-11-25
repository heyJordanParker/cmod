import { existsSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import * as core from '@cmodjs/core/src/mod.js'
import { bind, importsOnly } from '@cmodjs/core/src/runtime/bound.js'
import { connectScript } from '../script.js'

export const summary = "Run a TypeScript script that reads and drives this computer's sessions."

export const help = `Usage: cmod run <file> [arguments…]

${summary}

The script imports sessions, provide, and providers from @cmodjs/core/mod.js,
as a mod does, and cmod connects it to cmod serve: sessions.list, sessions.get,
and sessions.search read every session on this computer and on each device a
sessions provider serves, and a session's send, fork, and end reach the session
that runs it. A script hears no session, because a listener lives in the
session it listens to, so its on and before methods throw. providers(name)
answers every program on this computer that provides the interface, and
provide(name, methods) answers it for every session while the script runs. The
script reads its own arguments from Bun.argv[2] on.

cmod run ends once the script's top level has run.

Example:
  import { Prompt, sessions } from '@cmodjs/core/mod.js'
  const session = await sessions.get(Bun.argv[2])
  const [last] = await session.messages({ last: 1 })
  console.log(last?.type === 'reply' ? last.text : session.title)
  await session.send({ type: Prompt, text: 'Run the tests again.' })`

const coreModule = '@cmodjs/core/mod.js'

export async function run(argv: string[]): Promise<number> {
  const [file, ...args] = argv
  if (file === undefined) throw new Error(`cmod run takes the script to run.\n\n${help}`)
  const path = resolve(file)
  if (!existsSync(path)) throw new Error(`there is no script at ${path}.`)
  const name = basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'script'
  process.argv.splice(0, process.argv.length, process.execPath, path, ...args)
  const script = connectScript(name)
  bind(importsOnly({ sessions: script.sessions, provide: script.provide, providers: script.providers }, 'a cmod run script'))
  Bun.plugin({ name: 'cmod run', setup: (build) => void build.module(coreModule, () => ({ exports: core, loader: 'object' })) })
  try {
    await import(path)
    await new Promise((done) => setTimeout(done, 0))
  } finally {
    await script.close()
  }
  return 0
}
