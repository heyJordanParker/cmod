import { RuleTester } from 'oxlint/plugins-dev'
import { noSilentCatch } from './no-silent-catch.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const dropped = { messageId: 'dropped' }

tester.run('cmod/no-silent-catch', noSilentCatch, {
  valid: [
    'try { read() } catch (error) { if (!isMissing(error)) throw error }',
    'const text = await read(path).catch((error) => { if (isMissing(error)) return undefined; throw error })',
    'const text = await read(path).catch(ifMissing(undefined))',
    'promise.catch(() => undefined)',
    'void promise.catch(() => undefined)',
    'const parsed = await load().then((value) => value, ({ message }) => message)',
    'await load().then((value) => value)',
  ],
  invalid: [
    { code: 'try { read() } catch { return undefined }', errors: [dropped] },
    { code: 'try { read() } catch (error) { return undefined }', errors: [dropped] },
    { code: 'const text = await read(path).catch(() => undefined)', errors: [dropped] },
    { code: 'const text = await read(path).catch((error) => undefined)', errors: [dropped] },
    { code: 'const text = await read(path).catch(function () { return "" })', errors: [dropped] },
    { code: 'const loaded = await import(path).then((module) => module.default, () => undefined)', errors: [dropped] },
  ],
})
