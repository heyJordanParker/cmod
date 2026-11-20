import { parseArgs } from 'node:util'
import { pluginName } from '@cmodjs/core/src/records.js'
import { deleteSecrets, readSecret, storeSecret } from '../store.js'

export const summary = "Store, get, or delete one of a mod's secrets, as mod.secrets does."

export const help = `Usage: cmod secrets store <mod> <key>
       cmod secrets get <mod> <key>
       cmod secrets delete <mod> <key>

${summary}

store reads the value from stdin, such as
printf '%s' "$TOKEN" | cmod secrets store my-mod token, and get prints the
value to stdout as it was stored, or nothing when the mod has no secret
<key>. A value never goes in the arguments, where every process on the
computer can read it. Every mod's secrets live as plain text in secrets.json
in the cmod store, which only you can read. mod.secrets runs this command for
its mod, and cmod teardown deletes the secrets of a removed mod.`

const actions: readonly string[] = ['store', 'get', 'delete']

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
  const [action = '', mod = '', key = ''] = positionals
  if (positionals.length !== 3 || !actions.includes(action) || key === '') throw new Error(`cmod secrets takes store, get, or delete, a mod, and a key.\n\n${help}`)
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
  if (process.stdin.isTTY) throw new Error(`cmod secrets store reads the value from stdin, so a value typed here would show on the screen. Pipe it in, such as printf '%s' "$TOKEN" | cmod secrets store ${mod} ${key}.`)
  const value = await Bun.stdin.text()
  if (value === '') throw new Error(`cmod secrets store read no value from stdin. cmod secrets delete ${mod} ${key} deletes the secret.`)
  await storeSecret(mod, key, value)
  process.stdout.write(`Stored the secret ${key} of ${mod}.\n`)
  return 0
}
