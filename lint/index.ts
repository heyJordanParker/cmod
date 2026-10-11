import { eslintCompatPlugin } from '@oxlint/plugins'
import { noSilentCatch } from './no-silent-catch.ts'
import { programOwner } from './program-owner.ts'

export default eslintCompatPlugin({
  meta: { name: 'cmod' },
  rules: {
    'no-silent-catch': noSilentCatch,
    'program-owner': programOwner,
  },
})
