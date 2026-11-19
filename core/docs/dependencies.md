# Call another mod

A mod offers methods to other mods by returning them from `setup`, as a VS Code extension returns its API from `activate`. Another mod lists it as a dependency and calls those methods through `mod.dependencies`, typed from the provider's own types file.

## Offer methods: return them from setup

What `setup` returns is the mod's API: an object whose every value is a method. Each method gets the caller's input and returns its result or a promise of it. It reaches the provider's `mod` and state through `setup`'s scope. Inputs and results cross from one plugin to another, so keep them plain JSON data. A `setup` that returns anything else stops the mod with `<mod>: setup returns its API, an object of methods other mods call, or nothing.` A one-line `setup` returns what its call returns, so `setup: () => sessions.current.onPrompt(…)` offers that `Subscription`'s `remove` to other mods. Give such a `setup` braces.

```ts
import { defineMod, fs } from '../node_modules/@cmodjs/core/mod.js'

export const provider = defineMod({
  name: 'provider',
  setup() {
    return {
      lines: async ({ path }: { path: string }) => (await fs.read(path)).split('\n').length,
    }
  },
})
```

A call that reaches the mod while it is still starting waits for `setup` to return.

## Type the methods: CmodDependencies

The provider types the methods its `setup` returns in `types/index.d.ts`, and its `.claude-plugin/plugin.json` names that file as `"types": "./types/index.d.ts"`. The file adds the mod to `CmodDependencies`, which the Claude Mod Manager (cmod) plugin declares on the `claude-code` module:

```ts
export type Provider = {
  lines(input: { path: string }): Promise<number>
}

declare module 'claude-code' {
  interface CmodDependencies {
    provider: Provider
  }
}
```

- Each method takes one input and returns a promise.
- Once the name is in `CmodDependencies`, `tsc` checks what the provider's own `setup` returns against it, so a method that returns another shape fails `cmod check`.
- A types file augments only `'claude-code'`. Claude Code refuses a types file that augments any other module.

## Call the methods: mod.dependencies

A mod that calls the provider lists it in its own `.claude-plugin/plugin.json`, and Claude Code installs it with the mod:

```json
"dependencies": [{ "name": "cmod", "version": ">=5.2.0" }, "provider"]
```

Write the dependency bare, by its name alone. Claude Code looks for a bare dependency only in the mod's own marketplace, so `cmod publish` lists the provider there, from the `release` branch of the GitHub repository that the `"repository"` of the provider's `plugin.json` names. Install or link the provider before you publish, or `cmod publish` stops and says to. A dependency that names its `"marketplace"` loads for the people who install your mod, but not from the marketplace `cmod link` writes for your checkout.

A provider that changes or removes a method breaks every mod that calls it, and with automatic updates the provider can update first. Name the versions you tested with a range, and Claude Code turns your mod off with a clear error instead of letting its calls fail one by one:

```json
"dependencies": [{ "name": "cmod", "version": ">=5.2.0" }, { "name": "provider", "version": "^1.0" }]
```

Claude Code checks the range against the provider's `version` when it loads your mod. Every mod's marketplace lists cmod and each provider from its git repository, so Claude Code also installs it at the highest `<name>--v<version>` tag inside the range, which `cmod publish` pushes for every release ([Claude Code's plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies)).

cmod is a provider too, with one difference: every newer cmod runs every mod built on an older `@cmodjs/core`. So a mod names only the oldest cmod it runs on, which the `@cmodjs/core` it bundles names as `oldestCmodVersion` in its `records.js`, as `>=5.2.0`. When the mod needs a newer cmod, such as one whose cmod plugin carries out a call the mod makes, write that minimum as `>=` its version, as `>=5.6.0`. `cmod check` writes the newer of the two whenever the mod's `@cmodjs/core` changes, and `cmod publish` refuses a release whose range is not `>=` a version at or above `oldestCmodVersion`. A caret range such as `^5.0.0` stops Claude Code from updating cmod past 5.x for every mod on the computer, so leave it to `cmod check`.

Each mod's marketplace lists its own copy of cmod and of each provider, and Claude Code loads only one copy of each. When a mod needs a newer cmod than a copy Claude Code installed, the cmod plugin updates every copy of cmod, and when two copies of any plugin differ, it updates every copy of that plugin. Then each session offers Reload, so a mod never waits for the person to update its providers, only to press Reload.

Claude Code then lays the provider's types file beside the mod's own types, so the call is typed:

```ts
import { defineMod, sessions } from '../node_modules/@cmodjs/core/mod.js'

export const myMod = defineMod({
  name: 'my-mod',
  setup(mod) {
    sessions.current.onToolResult(async ({ files }) => {
      for (const path of files.changed) mod.log(`${path}: ${await mod.dependencies.provider.lines({ path })} lines`)
    })
  },
})
```

## Call a mod only when it runs: mods.isLoaded

A mod that works without another mod, and only uses it when the person has it, does not list it, because Claude Code installs every listed dependency for everyone who installs your mod. Ask whether it runs first, then call it through `mod.dependencies` as usual:

```ts
if (await mods.isLoaded('provider')) await mod.dependencies.provider.lines({ path })
```

```ts
isLoaded(name: string): Promise<boolean>
```

- `isLoaded` answers true when the mod runs in this Claude Code process, as one Claude Code loaded or one run from its checkout with `--plugin-dir`. A mod the person installed but turned off answers false.
- Claude Code lays a provider's types file beside your mod's only for a listed dependency, so type the methods you call in your own `types/index.d.ts`, with the shape the provider's types file exports, such as `interface CmodDependencies { provider: Provider }`.
- A mod that calls `mods.isLoaded` runs on cmod 5.4.0 or later, which the `cmod` range `cmod check` writes says.

## Interfaces: several mods answer one name

A dependency is one mod your mod calls by name. An interface is a name several mods answer, and the caller picks among the ones that run, as a terminal app, a remote machine, or a Markdown styler can each come from any mod. An interface is named `<mod>/<Name>`, after the mod that defines it, such as `anyhost/Platform`, and cmod defines four:

- `cmod/SessionStore` lists and reads sessions, and `cmod serve` answers it for this computer
- `cmod/Session` acts on a session and holds the listeners on it
- `cmod/Terminal` reads a session's screen, types keys into it, and shows it in a pane
- `cmod/Style` draws Markdown in a mod's own style

The mod that defines an interface types it in its types file, on `CmodInterfaces`, with its methods and the events it tells:

```ts
declare module 'claude-code' {
  interface CmodInterfaces {
    'anyhost/Platform': {
      methods: { machines(region: string): string[] }
      events: { MachineChange: { readonly name: string } }
    }
  }
}
```

A mod provides an interface from its session code with `mod.provide`, which answers the methods while the mod runs in that session, or from a `program` job with `provides` ([jobs.md](jobs.md#program)), which answers them for the whole computer and also tells events:

```ts
mod.provide('anyhost/Platform', { machines: async (region) => listMachines(region) })
mod.use(program({ command: ['anyhost', 'serve'], isService: true, provides: ['cmod/SessionStore', 'cmod/Session', 'cmod/Terminal'] }))
```

A caller asks `providers`, imported from `mod.js`, for the providers that run now, and calls each one's methods, typed from the interface:

```ts
providers<Name extends InterfaceName>(name: Name): Promise<InterfaceProvider<Name>[]>
```

```ts
for (const platform of await providers('anyhost/Platform')) {
  mod.log(`${platform.mod}: ${(await platform.machines('eu')).join(', ')}`)
  platform.onMachineChange((machine) => mod.log(`${machine.name} changed`))
}
```

- Each provider names its `mod`, and its `program` when a program provides it. The list holds every mod that provides the interface in this session and every program that provides it on this computer, in no set order.
- Each method returns a promise of what the provider's method returns, and rejects with the provider's error. A method the provider lacks rejects with `This program answers no <interface>.<method>.`, or `<mod> provides no <interface>.<method>.` from session code.
- Each event `E` has an `onE` and a `beforeE` method, as the session's listeners do ([session.md](session.md#listen-to-a-record)): an `onE` listener hears it, and a `beforeE` listener's answer reaches the program, which reads it as it defines. Both take a matcher, `timeoutMs`, and `onFailure`. Only a program tells events, so a listener on a provider in session code throws `<mod> tells <interface> events only from a program.`
- A provider that stops running leaves the list at the next call of `providers`.

A program serves its interfaces as JSON-RPC 2.0 over HTTP at the address it prints, which cmod reaches with one connection per session:

- `POST /rpc/connect` opens a connection and answers `{ "connection": <id> }`.
- `POST /rpc/<id>` takes a JSON-RPC message or batch from the caller and answers 204. A request names `<interface>.<method>`, such as `anyhost/Platform.machines`, with the method's arguments as its `params` array.
- `GET /rpc/<id>` answers the messages the program has for the caller, as a list, within 8 seconds, empty when it has none: the answers to its requests, and its own requests and notifications.
- `DELETE /rpc/<id>` closes the connection, and a connection that polls no more for 30 seconds closes too. A call on a closed connection answers 410, and the caller connects again.
- `$/listen` with `{ id, interface, kind, event, args?, matcher?, after? }` adds a listener on the connection, and `$/unlisten` with `{ id }` removes it. The program tells an `on` listener with the notification `$/on` `{ id, payload, cursor }`, and asks a `before` listener with the request `$/before` `{ id, payload }`, whose result is its answer. A listener that names `after`, a cursor it last heard, hears the events since. `$/cancelRequest` with `{ id }` cancels a request.

## When a call fails

A call that cannot answer rejects with one of these reasons:

```text
<provider> is not installed. Install it in Plugins.
<provider> is not set up: <why its setup failed>
<provider> is installing. Try again when it's ready.
<provider> has no method <method>.
<provider>: <the message of the error the method threw>
```

- `<provider> is not installed` covers a provider whose code did not load. The caller's error toast shows a `Plugins` button, which opens Claude Code's `/plugin`.
- `<provider> is not set up` covers a provider the person declined to install and one whose install failed, and names why. The provider's own toast shows the same reason, with `Retry` or `Install`.
- `<provider> is installing` covers a provider whose install step still runs 5 seconds after the call. A provider that is installing or only starting makes the call wait for it, up to 5 seconds.
- When the provider is disabled, Claude Code unloads the mod that lists it, with its own error, which starts `Dependency "<provider>" is disabled`.
- A call fails with `mod.dependencies.<provider>.<method> passed its 30 s deadline` when the other mod takes longer than 30 seconds. A job bounds the whole function that makes the call by its own deadline ([jobs.md](jobs.md)), so a slow call inside `slashCommand` can fail the command first, with `/<command> passed the 30 s deadline of slashCommand`.

```ts
notInstalled(name: string): string
```

`notInstalled`, exported from `mod.js`, returns the first reason for a mod name: `<name> is not installed. Install it in Plugins.` A test uses it to expect that message.

## Test the calls

`testMod(myMod, { dependencies: { provider: { lines: async () => 3 } } })` answers the provider's methods with the functions given. A call to a mod the test does not fake fails with `<provider> is not installed. Install it in Plugins.`, as in Claude Code. [testing.md](testing.md) covers it.

A test of the provider's own methods fires `cmod.call`, as a caller's `mod.dependencies` does. The answer is `{ value }` with what the method returned, or `{ deny }` with the reason it failed:

```ts
const tested = testMod(provider, { files: { '/work/a.ts': 'a\nb\nc' } })

expect(await tested.fire('cmod.call', { to: 'provider', method: 'lines', input: { path: '/work/a.ts' } })).toEqual({ value: 3 })
```
