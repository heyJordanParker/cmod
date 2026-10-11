import { RuleTester } from 'oxlint/plugins-dev'
import { programOwner } from './program-owner.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const owners = [{ claude: 'cli/src/claude.ts' }]

tester.run('cmod/program-owner', programOwner, {
  valid: [
    { code: "await capture(['claude', 'plugin', 'list'])", filename: '/repo/cli/src/claude.ts', options: owners },
    { code: "await capture(['git', 'status'])", filename: '/repo/cli/src/commands/check.ts', options: owners },
    { code: "const names = ['claude']", filename: '/repo/cli/src/commands/check.ts', options: [{}] },
  ],
  invalid: [
    {
      code: "await capture(['claude', 'plugin', 'validate', path, '--strict'])",
      filename: '/repo/cli/src/commands/check.ts',
      options: owners,
      errors: [{ messageId: 'owned', data: { owner: 'cli/src/claude.ts', program: 'claude' } }],
    },
  ],
})
