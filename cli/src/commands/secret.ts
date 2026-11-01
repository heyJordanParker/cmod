import { parseArgs } from 'node:util'
import { pluginName } from '@cmodjs/core/src/records.js'
import { deleteSecrets, readSecret, storeSecret } from '../store.js'

export const summary = "Store, get, or delete one of a mod's secrets, as mod.secrets does."

export const help = `Usage: cmod secret store <mod> <key>
       cmod secret get <mod> <key>
       cmod secret delete <mod> <key>

${summary}

store reads the value from stdin, such as
printf '%s' "$TOKEN" | cmod secret store anyhost token, and get prints the
value to stdout as it was stored, or nothing when the mod has no secret
<key>. A value never goes in the arguments, where every process on the
computer can read it. Every mod's secrets live in secrets.json in the cmod
store, which only you can read. On macOS each value is encrypted there with
AES-256-GCM, under one random key cmod keeps in your login keychain as the
cmod Safe Storage item, as Chrome and VS Code keep theirs. mod.secrets runs
this command for its mod, and cmod teardown deletes the secrets of a removed
mod.`

const actions: readonly string[] = ['store', 'get', 'delete']

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  const [action = '', mod = '', key = ''] = positionals
  if (positionals.length !== 3 || !actions.includes(action) || key === '') throw new Error(`cmod secret takes store, get, or delete, a mod, and a key.\n\n${help}`)
  if (!pluginName.test(mod)) throw new Error(`"${mod}" is not a plugin name: use letters, digits, ".", "_", and "-", starting with a letter or digit.`)
  if (action === 'get') {
    process.stdout.write((await readSecret(mod, key)) ?? '')
    return 0
  }
  if (action === 'delete') {
    await deleteSecrets(mod, [key])
    process.stdout.write(`Deleted the secret ${key} of ${mod}.\n`)
    return 0
  }
  if (process.stdin.isTTY) throw new Error(`cmod secret store reads the value from stdin, so a value typed here would show on the screen. Pipe it in, such as printf '%s' "$TOKEN" | cmod secret store ${mod} ${key}.`)
  const value = await Bun.stdin.text()
  if (value === '') throw new Error(`cmod secret store read no value from stdin. cmod secret delete ${mod} ${key} deletes the secret.`)
  await storeSecret(mod, key, value)
  process.stdout.write(`Stored the secret ${key} of ${mod}.\n`)
  return 0
}
