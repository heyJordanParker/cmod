# Call another mod

A mod offers methods to other mods in `api`. Another mod lists it as a dependency and calls those methods through `mod.dependencies`, typed from the provider's own types file.

## Offer methods: api

Each method of `api` gets the caller's input and the provider's own `mod`, and returns its result or a promise of it. Inputs and results cross from one plugin to another, so keep them plain JSON data.

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'

export const tracer = defineMod({
  name: 'tracer',
  api: {
    signatures: async ({ path }: { path: string }, mod) =>
      (await mod.fs.read(path)).split('\n').flatMap((text, index) => {
        const name = /^export function (\w+)/.exec(text)?.[1]
        return name === undefined ? [] : [{ name, line: index + 1 }]
      }),
  },
  setup() {},
})
```

## Type the methods: CmodDependencies

The provider types its `api` in `types/index.d.ts`, and its `.claude-plugin/plugin.json` names that file as `"types": "./types/index.d.ts"`. The file adds the mod to `CmodDependencies`, which the Claude Mod Manager (cmod) plugin declares on the `claude-code` module:

```ts
export type TracerSignature = { name: string; line: number }

export type Tracer = {
  signatures(input: { path: string }): Promise<TracerSignature[]>
}

declare module 'claude-code' {
  interface CmodDependencies {
    tracer: Tracer
  }
}
```

- Each method takes one input and returns a promise.
- Once the name is in `CmodDependencies`, `tsc` checks the provider's own `api` against it, so a method that returns another shape fails `cmod check`.
- A types file augments only `'claude-code'`. Claude Code refuses a types file that augments any other module.

## Call the methods: mod.dependencies

A mod that calls tracer lists it in its own `.claude-plugin/plugin.json`, and Claude Code installs it with the mod:

```json
"dependencies": ["cmod", "tracer"]
```

A provider that changes or removes a method breaks every mod that calls it, and with automatic updates the provider can update first. Name the versions you tested with a range, and Claude Code turns your mod off with a clear error instead of letting its calls fail one by one:

```json
"dependencies": ["cmod", { "name": "tracer", "version": "^1.0" }]
```

Claude Code checks the range against the `version` in the provider's `plugin.json` when it loads your mod ([Claude Code's plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies)).

Claude Code then lays tracer's types file beside the mod's own types, so the call is typed:

```ts
import { defineMod } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'

export const outline = defineMod({
  name: 'outline',
  setup(mod) {
    mod.use(
      slashCommand({
        name: 'outline',
        description: 'List the functions a file exports',
        reply: async ({ args }, mod) => {
          const signatures = await mod.dependencies.tracer.signatures({ path: args })
          return signatures.map(({ name, line }) => `${name}:${line}`).join('\n')
        },
      }),
    )
  },
})
```

## When a call fails

A call that cannot answer rejects with one of these messages:

```text
tracer is not installed. Run cmod install tracer.
tracer is installing. Try again when it's ready.
tracer has no method signatures.
tracer: <the message of the error the method threw>
```

- `tracer is not installed` covers a provider whose code did not load, one the person declined to install, and one whose install failed.
- `tracer is installing` covers a provider that is still running its install step.
- When tracer is disabled, Claude Code unloads the mod that lists it, with its own error: `Dependency "tracer" is disabled — enable it or remove the dependency`.
- A call runs inside the deadline of the job that makes it ([jobs.md](jobs.md)), and 30 seconds anywhere else. Past the deadline of a job, the call fails with `mod.dependencies.tracer.signatures passed the 30 s deadline of slashCommand`, naming the job. Anywhere else it fails with `mod.dependencies.tracer.signatures passed its 30 s deadline`.

```ts
notInstalled(name: string): string
```

`notInstalled`, exported from `mod.js`, returns the first message for a mod name: `<name> is not installed. Run cmod install <name>.` A test uses it to expect that message.

## Test the calls

`testMod(outline, { dependencies: { tracer: { signatures: async () => [] } } })` answers tracer's methods with the functions given. A call to a mod the test does not fake fails with `tracer is not installed. Run cmod install tracer.` [testing.md](testing.md) covers it.

A test of the provider's own `api` fires `cmod.call`, as a caller's `mod.dependencies` does. The answer is `{ value }` with what the method returned, or `{ deny }` with the reason it failed:

```ts
const tested = testMod(tracer, { files: { '/work/a.ts': 'export function greet() {}\n' } })

expect(await tested.fire('cmod.call', { to: 'tracer', method: 'signatures', input: { path: '/work/a.ts' } })).toEqual({ value: [{ name: 'greet', line: 1 }] })
```
