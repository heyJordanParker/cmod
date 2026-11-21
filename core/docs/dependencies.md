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
"dependencies": [{ "name": "cmod", "version": ">=8.0.0" }, "provider"]
```

Write the dependency bare, by its name alone. Claude Code looks for a bare dependency only in the mod's own marketplace, so `cmod publish` lists the provider there, from the `release` branch of the GitHub repository that the `"repository"` of the provider's `plugin.json` names. Install or link the provider before you publish, or `cmod publish` stops and says to. A dependency that names its `"marketplace"` loads for the people who install your mod, but not from the marketplace `cmod link` writes for your checkout.

A provider that changes or removes a method breaks every mod that calls it, and with automatic updates the provider can update first. Name the versions you tested with a range, and Claude Code turns your mod off with a clear error instead of letting its calls fail one by one:

```json
"dependencies": [{ "name": "cmod", "version": ">=8.0.0" }, { "name": "provider", "version": "^1.0" }]
```

Claude Code checks the range against the provider's `version` when it loads your mod. Every mod's marketplace lists cmod and each provider from its git repository, so Claude Code also installs it at the highest `<name>--v<version>` tag inside the range, which `cmod publish` pushes for every release ([Claude Code's plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies)).

cmod is a provider too, with one difference: every newer cmod runs every mod built on an older `@cmodjs/core`. So a mod names only the oldest cmod it runs on, which the `@cmodjs/core` it bundles names as `oldestCmodVersion` in its `records.js`, as `>=8.0.0`. When the mod needs a newer cmod, such as one whose cmod plugin carries out a call the mod makes, write that minimum as `>=` its version, as `>=8.1.0`. `cmod check` writes the newer of the two whenever the mod's `@cmodjs/core` changes, and `cmod publish` refuses a release whose range is not `>=` a version at or above `oldestCmodVersion`. A caret range such as `^8.0.0` stops Claude Code from updating cmod past 8.x for every mod on the computer, so leave it to `cmod check`.

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

A provider is a mod, or a mod's program, that implements a feature an interface defines. It follows VS Code's providers: an extension registers a `HoverProvider` with `registerHoverProvider`, and VS Code asks every registered `HoverProvider` for its hover. A caller asks `providers(name)` for every provider that runs and calls each one, where a dependency is one mod your mod calls by name. So a terminal app, a remote device, or a Markdown styler can each come from any mod.

An interface is named `<mod>/<Name>`, after the mod that defines it, such as `demo/Platform`, and cmod defines six:

- `cmod/Sessions` lists, searches, and reads sessions, acts on them, and tells a `Change` for each session that starts or stops running, is visited or deleted, or changes its tasks, goal, or status, as one VS Code `FileSystemProvider` reads, writes, and reports changes for its scheme. `cmod serve` provides it for this computer, the `cmod serve` of each device a `cmod/Devices` provider names provides it for that device, and a mod whose program serves another device's sessions provides it for that device ([session.md](session.md#sessions-providers)).
- `cmod/Devices` says where the `cmod serve` of each of your other devices listens, or carries its messages, so `cmod serve` reaches the providers there ([cmod/Devices](#cmod-devices-providers-on-your-other-devices)).
- `cmod/UI` lists, draws, and presses each session's widgets, views, and pages, and tells a `Change` when a mod adds or removes one and a `Redraw` when one may draw new data, so an app such as the browser app draws every mod's UI. Each session's cmod plugin answers it for its own session, and `cmod serve` sends each call to the plugin that holds the session the call names ([ui.md](ui.md#every-app-reaches-them-through-cmod-ui)).
- `cmod/Terminal` reads a session's screen, types keys into it, and shows it in a pane. `cmod serve` provides it, first in the list, for each session that runs in a terminal of herdr-core, the terminals the Herdr app shows, and answers not held for any other, so a mod whose program hosts other terminals provides it for those. Its provider tells `Shown { session, place }` after each `show` and `Pressed { session }` after each `press`, so a program that keeps track of which sessions are in use hears an agent's use of one.
- `cmod/Providers` tells a `Change { interface, device }` each time a provider of an interface starts or stops: a program on this computer or on a device `cmod serve` reaches, or a mod's session code in your own session, and once for each interface you listen for when a device is reached or lost, as VS Code's `extensions.onDidChange` fires when the set of extensions changes. `cmod serve` of this computer provides it, so a caller that waits for a provider listens and calls `providers(name)` again on each `Change`:

  ```ts
  const [watch] = await providers('cmod/Providers')
  watch?.onChange({ interface: 'demo/Platform' }, async () => platforms.set(await providers('demo/Platform')))
  ```

- `cmod/Style` draws Markdown in a mod's own style. Every mod with a Markdown style provides it, with no `provide` call ([ui.md](ui.md#styles-change-how-claude-code-draws)).

`@cmodjs/core` types cmod's own interfaces, so they type-check in every mod. The mod that defines any other interface types it in its types file, on `CmodInterfaces`, with its methods and the events it tells:

```ts
declare module 'claude-code' {
  interface CmodInterfaces {
    'demo/Platform': {
      methods: { machines(region: string): string[] }
      events: { MachineChange: { readonly name: string } }
    }
  }
}
```

A mod provides an interface with `provide`, imported from `mod.js` beside `providers`, as VS Code's `registerXProvider` is a function of its namespace. `provide` returns a `Provided`: its `remove()` stops providing, its `tell` tells one of the interface's events to every `onE` listener on this provider, as a VS Code provider fires its own `onDidChange` event, and its `ask` asks every `beforeE` listener before the provider acts, as VS Code's `onWillSaveTextDocument` waits for its listeners.

```ts
provide<Name extends InterfaceName>(name: Name, methods: InterfaceMethods<Name>): Provided<Name>

type Provided<Name> = Subscription & {
  tell<Event>(event: Event, payload: EventsOf<Name>[Event]): void
  ask<Event>(event: Event, payload: EventsOf<Name>[Event]): Promise<unknown[]>
}
```

`ask` asks the listeners one at a time and resolves with each answer in the order it asked, leaving out a listener that answered nothing. It stops at the first answer that holds `refuse`, so no listener after it is asked. Each listener runs within its own `timeoutMs`, 10 seconds when it gives none, and a listener that throws, passes its `timeoutMs`, or cannot be reached counts as its `onFailure` says: `'pass'`, the default, leaves its answer out, and `'refuse'` answers `{ refuse: '<its error>' }`. A provider reads the answers as its interface defines them:

```ts
const rules = provide('demo/Rules', {})
const answers = (await rules.ask('Check', { tool: 'Bash' })) as { readonly refuse?: string; readonly rules?: Record<string, 'off' | 'warn'> }[]
```

Another mod in the session answers with a `beforeE` listener on that provider:

```ts
const [rules] = await providers('demo/Rules')
rules?.beforeCheck((check) => (check.tool === 'Bash' ? { rules: { 'no-rm': 'off' } } : undefined), { timeoutMs: 2000 })
```

From session code, `provide` answers the methods while the mod runs in that session, and only callers in that session reach it and hear what it tells, as a VS Code window's provider serves only that window. The cmod plugin carries each `tell` and `ask` to the session's listeners, as `cmod serve` carries a program's, so a `tell` inside a method that answers a call, or an `ask` inside the mod's own `beforeToolCall` listener, still reaches the caller:

```ts
const platform = provide('demo/Platform', { machines: async (region) => listMachines(region) })
platform.tell('MachineChange', { name: 'eu-1' })
```

From a program that a `program` job with `singleInstance` or `isService` runs ([jobs.md](jobs.md#program)), `provide` answers the methods and tells the events for the whole computer, through the program's connection to `cmod serve`, which `connect()` opens:

```ts
import { provide } from '@cmodjs/core/mod.js'
import { connect } from '@cmodjs/core/rpc.js'

await connect()
const platform = provide('demo/Platform', { machines: async (region) => listMachines(region) })
platform.tell('MachineChange', { name: 'eu-1' })
```

### connect: a program's connection to cmod serve

`connect`, imported from `rpc.js`, opens the program's one connection to this computer's `cmod serve`, the hub that holds every program's providers and carries each call to the provider it names, as VS Code's window holds every extension's providers:

```ts
connect(): Promise<Connection>

type Connection = {
  call(name: string, method: string, params: readonly unknown[]): Promise<unknown>
  listen(name: string, event: string, listener: (payload: unknown, signal: AbortSignal) => unknown): Subscription
  tell(name: string, event: string, payload: unknown): void
  ask(name: string, event: string, payload: unknown): Promise<unknown[]>
  close(): Promise<void>
}
```

- It names the mod by `CMOD_MOD` and the program by `CMOD_PROGRAM`, which `cmod program` sets for each program it starts, and rejects with `connect() names its mod by CMOD_MOD, which cmod program sets for every program it starts, and CMOD_MOD is not set.` outside one.
- It resolves once `cmod serve` answers on `serve.sock` in the cmod store, and connects again, and provides again, whenever `cmod serve` starts again.
- After it, the program imports `provide` and `providers` from `mod.js`. Every other import throws `<mod>'s program imports only provide and providers from @cmodjs/core/mod.js, because <import> belongs to a Claude Code session.`
- `tell` is what `Provided`'s `tell` runs: it tells every `onE` listener on this program's provider of `name`.
- `ask` is what `Provided`'s `ask` runs: it asks every `beforeE` listener on this program's provider of `name`, in a session or a program, on this computer or a device `cmod serve` reaches.
- `call` and `listen` reach an interface without picking a provider: `cmod serve` answers `cmod/Sessions` and `cmod/UI` itself, sends any other interface to its one provider, on this computer or a device it reaches, and refuses when no program or several provide it. `providers` picks one.
- `call` rejects with `<interface>.<method> passed its 30 s deadline` when the provider has not answered after 30 seconds, such as a provider on a device that went to sleep mid-call. It then sends `$/cancelRequest`, so the provider's handler sees its signal abort.
- `close` ends the connection, and `cmod serve` drops the program's providers with it.
- A program that only provides prints no address, so its job's `ready()` rejects once it runs. Its mod waits with the job's `provider(name)` instead, which resolves with that program's provider of `name` once the program provides it ([jobs.md](jobs.md#program)).

A `cmod/Sessions` provider answers every method its type in the cmod plugin's types file names. Each method on one session takes the session's id first. For a session the provider does not hold, the method throws `NotHeld`, imported from `rpc.js`, so cmod asks the next provider, as a VS Code `FileSystemProvider` throws `FileSystemError.FileNotFound`. Its message is `This provider holds no session <id>.`, which the caller reads when no provider holds the session. Any other error ends the call with its message, and cmod asks no further provider:

```ts
import { provide } from '@cmodjs/core/mod.js'
import { connect, NotHeld } from '@cmodjs/core/rpc.js'

await connect()
provide('cmod/Sessions', {
  read: async (session, part, options) => {
    const device = await deviceOf(session)
    if (device === undefined) throw new NotHeld(session)
    return device.read(session, part, options)
  },
  ...
})
```

`startTask` takes the whole task, `device` included: a provider that serves the device the task names starts the session there and answers its task, and any other throws `NotHeld`. The provider tells a `Change` with `part: 'running'` when one of its sessions stops running, which closes the task of the session that started it.

A caller asks `providers`, imported from `mod.js`, for the providers that run now, and calls each one's methods, typed from the interface:

```ts
providers<Name extends InterfaceName>(name: Name): Promise<InterfaceProvider<Name>[]>
```

```ts
for (const platform of await providers('demo/Platform')) {
  mod.log(`${platform.mod}: ${(await platform.machines('eu')).join(', ')}`)
  platform.onMachineChange((machine) => mod.log(`${machine.name} changed`))
}
```

- Each provider names its `mod`, its `program` when a program provides it, and its `device`, the `{ id, name }` of the computer it runs on, in the shape `device.read()` answers ([mod.md](mod.md#device-the-computer-the-session-runs-on)). The list holds every mod that provides the interface in this session, every program that provides it on this computer, which `cmod serve` holds, and every program that provides it on a device `cmod serve` reaches ([cmod/Devices](#cmod-devices-providers-on-your-other-devices)), in no set order.
- Each method returns a promise of what the provider's method returns, and rejects with the provider's error. A method the provider lacks rejects with `This program answers no <interface>.<method>.`, or `<mod> provides no <interface>.<method>.` from session code. A method that has not answered after 30 seconds rejects with `<interface>.<method> passed its 30 s deadline`, as a `mod.dependencies` call does ([When a call fails](#when-a-call-fails)).
- Each event `E` has an `onE` and a `beforeE` method, as the session's listeners do ([session.md](session.md#listen-to-a-record)): an `onE` listener hears what the provider tells with `Provided`'s `tell`, and a `beforeE` listener's answer reaches the provider that asks it with `Provided`'s `ask`, or a program that asks it with `$/before`, which reads it as it defines. Both take a matcher, `timeoutMs`, and `onFailure`.
- A provider that stops running leaves the list at the next call of `providers`. A program's providers leave when its connection closes, and a program that dies closes it at once, because `cmod serve` closes a connection whose poll the program left. A call to a provider that left fails with `<mod>'s <program> program does not run, so it answers no <interface>.`

A program in a language with no `connect()` speaks the wire `connect()` speaks, JSON-RPC 2.0 over HTTP on `serve.sock` in the cmod store:

- `POST /rpc/connect` opens a connection and answers `{ "connection": <id> }`.
- `POST /rpc/<id>` takes a JSON-RPC message or batch from the program and answers 204.
- `GET /rpc/<id>` answers the messages `cmod serve` has for the program, as a list, within 8 seconds, empty when it has none: the answers to its requests, and the requests and notifications of its callers.
- `DELETE /rpc/<id>` closes the connection, and so does a `GET` the program leaves before its answer, or no poll for 30 seconds. A call on a closed connection answers 410, and the program connects again.
- `$/provide` with `{ interface, mod, program }` makes the connection that program's provider of the interface, and `$/unprovide` with `{ interface }` stops it. `cmod serve` sends the program each call as a request that names `<interface>.<method>`, such as `demo/Platform.machines`, with the method's arguments as its `params` array.
- A `cmod/Sessions` provider answers a call on a session it does not hold with the JSON-RPC error code `-32098`, the answer `NotHeld` sends, and cmod asks the next provider. Any other error code ends the call with the error's message.
- `cmod serve` sends each listener as `$/listen` with `{ id, interface, kind, event, args?, matcher?, after? }`, and `$/unlisten` with `{ id }` removes it. The program tells an `on` listener with the notification `$/on` `{ id, payload, cursor }`, and asks a `before` listener with the request `$/before` `{ id, payload }`, whose result is its answer. A listener that names `after`, a cursor it last heard, hears the events since. `$/cancelRequest` with `{ id }` cancels a request.
- `$/providers` with `{ interface }` answers each program that provides it as `{ mod, program, device }`, and `$/call` with `{ interface, method, args, mod, program, device }` calls that program's method. `$/providers` with `{ interface, device }` answers only the providers of this computer, and only when `device` is its id, which is how one `cmod serve` asks another.
- `$/provider` with `{ interface, mod, program }` answers `{ mod, program, device }` once that program on this computer provides the interface, at once when it already does. `$/cancelRequest` stops the wait.

### cmod/Devices: providers on your other devices

A mod that links your devices, such as one that reaches them over ssh, a tailnet, or a relay, provides `cmod/Devices` from its program. For each other device it gives where that device's `cmod serve` listens, or carries that `cmod serve`'s messages itself, as a VS Code `RemoteAuthorityResolver` answers an address or a `ManagedMessagePassing`:

```ts
'cmod/Devices': {
  methods: {
    devices(): { id: string; name: string; address?: string }[]
    send(device: string, message: unknown): void
  }
  events: { Change: { readonly device: string }; Message: { readonly device: string; readonly message: unknown } }
}
```

- `id` is the device's cmod device id, which `cmod device --json` prints on that device, and `name` its name.
- `cmod serve` asks every `cmod/Devices` provider on this computer for its devices when it provides the interface, reaches the `cmod serve` of each device, and lists that device's providers beside this computer's, each with its `device`.
- The provider tells `Change`, with the id of the device that changed, whenever its list changes. `cmod serve` then reads every list again: it reaches a new device, reaches again a device whose address or provider changed, and drops a device no list holds.

A device with an `address` is reached there. The address is where that device's `cmod serve` answers the wire above: a unix socket path, such as the end of an ssh tunnel, or an `http://` URL. The mod opens the link its own way, and cmod reaches the address with its own JSON-RPC over HTTP, which polls every 8 seconds.

A device with no `address` is reached through its provider, over one message channel. `cmod serve` sends each JSON-RPC message for that device's `cmod serve` with `send`, and the provider tells each message from that device as `Message`, in the order they came, and never reads one. A provider that links devices through a relay carries them both ways:

```ts
await connect()
const devices = provide('cmod/Devices', {
  devices: () => relay.peers().map(({ id, name }) => ({ id, name })),
  send: (device, message) => relay.send(device, message),
})
relay.onMessage((device, message) => devices.tell('Message', { device, message }))
relay.onPeersChange((device) => devices.tell('Change', { device }))
```

- The channel is a peer link: the same `cmod serve` both asks and answers over it, so each device's provider lists the other.
- Nothing polls across it. It carries a message only when a call, a listener, or an event needs one.
- Each `cmod serve` opens its end with the notification `$/link` `{ link }`, and answers the other end's with `$/link` `{ link, answers }`. It lists that device's providers once the two ends linked, so a device whose `cmod serve` never answers stays out of `providers`.
- A `$/link` from a device it already linked with means that device's `cmod serve` started again. `cmod serve` fails each call still waiting on the old link with `The connection closed: the cmod serve of <device> linked again`, and listens there again.
- A call whose message `send` fails rejects with `<mod>'s <program> program carried no message to <device>: <its error>`.
- `cmod serve` carries each call and listener on another device's provider to that device's `cmod serve`. Each `cmod serve` offers another device only its own computer's providers, never ones it carries, so a call takes one hop even when two devices list each other.
- A session's own providers stay in that session, as a VS Code window's do.

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
- A call fails with `mod.dependencies.<provider>.<method> passed its 30 s deadline` when the other mod takes longer than 30 seconds. A call to a provider's method keeps the same 30 s deadline, from session code and from a program, and fails with `<interface>.<method> passed its 30 s deadline`, such as `demo/Platform.machines passed its 30 s deadline`, and cancels the request it left with the provider. A listener is no call, so it keeps no deadline, and `Provided`'s `ask` bounds each listener by its own `timeoutMs`. A job bounds the whole function that makes the call by its own deadline ([jobs.md](jobs.md)), so a slow call inside `slashCommand` can fail the command first, with `/<command> passed the 30 s deadline of slashCommand`.

```ts
notInstalled(name: string): string
```

`notInstalled`, exported from `mod.js`, returns the first reason for a mod name: `<name> is not installed. Install it in Plugins.` A test uses it to expect that message.

## Test the calls

`testMod(myMod, { dependencies: { provider: { lines: async () => 3 } } })` answers the provider's methods with the functions given. A call to a mod the test does not fake fails with `<provider> is not installed. Install it in Plugins.`, as in Claude Code. [testing.md](testing.md) covers it.

`testMod(myMod, { providers: [{ name: 'demo/Platform', mod: 'demo', program: 'platform', methods: { machines: () => ['eu-1'] } }] })` fakes a provider of an interface, on this computer or on a device it names, and `tested.providers` tells its events and asks its `beforeE` listeners ([testing.md](testing.md#providers)).

A test of the provider's own methods fires `cmod.call`, as a caller's `mod.dependencies` does. The answer is `{ value }` with what the method returned, or `{ deny }` with the reason it failed:

```ts
const tested = testMod(provider, { files: { '/work/a.ts': 'a\nb\nc' } })

expect(await tested.fire('cmod.call', { to: 'provider', method: 'lines', input: { path: '/work/a.ts' } })).toEqual({ value: 3 })
```
