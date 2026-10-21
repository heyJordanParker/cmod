# Call another mod

A mod offers methods to other mods by returning them from `setup`, as a VS Code extension returns its API from `activate`. Another mod lists it as a dependency and calls those methods through `mod.dependencies`, typed from the provider's own types file.

## Offer methods: return them from setup

What `setup` returns is the mod's API: an object whose every value is a method. Each method gets the caller's input and returns its result or a promise of it. It reaches the provider's `mod` and state through `setup`'s scope. Inputs and results cross from one plugin to another, so keep them plain JSON data. A `setup` that returns anything else stops the mod with `<mod>: setup returns its API, an object of methods other mods call, or nothing.` A one-line `setup` returns what its call returns, so `setup: () => sessions.current.onPrompt(…)` offers that `Subscription`'s `remove` to other mods. Give such a `setup` braces.

```ts
import { defineMod, fs } from '../node_modules/@cmodjs/core/mod.js'

export const tracer = defineMod({
  name: 'tracer',
  setup() {
    return {
      signatures: async ({ path }: { path: string }) =>
        (await fs.read(path)).split('\n').flatMap((text, index) => {
          const name = /^export function (\w+)/.exec(text)?.[1]
          return name === undefined ? [] : [{ name, line: index + 1 }]
        }),
    }
  },
})
```

A call that reaches the mod while it is still starting waits for `setup` to return.

## Type the methods: CmodDependencies

The provider types the methods its `setup` returns in `types/index.d.ts`, and its `.claude-plugin/plugin.json` names that file as `"types": "./types/index.d.ts"`. The file adds the mod to `CmodDependencies`, which the Claude Mod Manager (cmod) plugin declares on the `claude-code` module:

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
- Once the name is in `CmodDependencies`, `tsc` checks what the provider's own `setup` returns against it, so a method that returns another shape fails `cmod check`.
- A types file augments only `'claude-code'`. Claude Code refuses a types file that augments any other module.

## Call the methods: mod.dependencies

A mod that calls tracer lists it in its own `.claude-plugin/plugin.json`, and Claude Code installs it with the mod:

```json
"dependencies": [{ "name": "cmod", "version": ">=4.0.0" }, "tracer"]
```

A provider that changes or removes a method breaks every mod that calls it, and with automatic updates the provider can update first. Name the versions you tested with a range, and Claude Code turns your mod off with a clear error instead of letting its calls fail one by one:

```json
"dependencies": [{ "name": "cmod", "version": ">=4.0.0" }, { "name": "tracer", "version": "^1.0" }]
```

Claude Code checks the range against the provider's `version` when it loads your mod. Where a marketplace lists the provider from its git repository, as every mod's marketplace lists cmod, Claude Code also installs it at the highest `<name>--v<version>` tag inside the range, which `cmod publish` pushes for every release ([Claude Code's plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies)).

cmod is a provider too, with one difference: every newer cmod runs every mod built on an older `@cmodjs/core`. So a mod names only the oldest cmod it runs on, the version of the `@cmodjs/core` it bundles, as `>=4.0.0`. `cmod check` writes that range whenever the mod's `@cmodjs/core` changes, and `cmod publish` refuses a release whose range differs. A caret range such as `^4.0.0` stops Claude Code from updating cmod past 4.x for every mod on the computer, so leave it to `cmod check`.

Each mod's marketplace lists its own copy of cmod, and Claude Code loads only one of them. When a mod needs a newer cmod than a copy Claude Code installed, or two copies differ, the cmod plugin updates every copy and reloads the mods, so a mod never waits for the person to update cmod.

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

A call that cannot answer rejects with one of these reasons:

```text
tracer is not installed. Install it in Plugins.
tracer is not set up. Its toast says why.
tracer is installing. Try again when it's ready.
tracer has no method signatures.
tracer: <the message of the error the method threw>
```

- `tracer is not installed` covers a provider whose code did not load. The caller's error toast shows a `Plugins` button, which opens Claude Code's `/plugin`.
- `tracer is not set up` covers a provider the person declined to install and one whose install failed. Its own toast shows why, with `Retry` or `Install`.
- `tracer is installing` covers a provider that is still running its install step. A provider that is only starting makes the call wait for it, up to 9 seconds.
- When tracer is disabled, Claude Code unloads the mod that lists it, with its own error: `Dependency "tracer" is disabled — enable it or remove the dependency`.
- A call fails with `mod.dependencies.tracer.signatures passed its 30 s deadline` when the other mod takes longer than 30 seconds. A job bounds the whole function that makes the call by its own deadline ([jobs.md](jobs.md)), so a slow call inside `slashCommand` can fail the command first, with `/outline passed the 30 s deadline of slashCommand`.

```ts
notInstalled(name: string): string
```

`notInstalled`, exported from `mod.js`, returns the first reason for a mod name: `<name> is not installed. Install it in Plugins.` A test uses it to expect that message.

## Test the calls

`testMod(outline, { dependencies: { tracer: { signatures: async () => [] } } })` answers tracer's methods with the functions given. A call to a mod the test does not fake fails with `tracer is not installed. Install it in Plugins.`, as in Claude Code. [testing.md](testing.md) covers it.

A test of the provider's own methods fires `cmod.call`, as a caller's `mod.dependencies` does. The answer is `{ value }` with what the method returned, or `{ deny }` with the reason it failed:

```ts
const tested = testMod(tracer, { files: { '/work/a.ts': 'export function greet() {}\n' } })

expect(await tested.fire('cmod.call', { to: 'tracer', method: 'signatures', input: { path: '/work/a.ts' } })).toEqual({ value: [{ name: 'greet', line: 1 }] })
```
