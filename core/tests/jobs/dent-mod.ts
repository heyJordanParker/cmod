import type { ProcessRunResult } from 'claude-code'
import { check } from '../../src/jobs/check.js'
import { permissions, type FileCall } from '../../src/jobs/permissions.js'
import { defineMod, type Mod } from '../../src/mod.js'

const skipPattern = /\.skip\(|markTestSkipped\(/g
const addsSkip = (previousContent: string | undefined, content: string) =>
  (content.match(skipPattern) ?? []).length > ((previousContent ?? '').match(skipPattern) ?? []).length
const hasCodeChanges = ({ stdout }: ProcessRunResult) => stdout.split('\n').some((line) => line.trim() !== '' && !line.endsWith('Domain.md'))
const tableOf = (path: string) => /create_(\w+?)_table|create_(\w+)\.php$/.exec(path)?.slice(1).find((name) => name !== undefined)
const duplicatesTable = async (call: FileCall, mod: Mod) => {
  const table = tableOf(call.path)
  const { stdout } = await mod.process.run(['git', 'status', '--porcelain', '-uall'])
  return table !== undefined && stdout.split('\n').some((line) => line.includes('database/migrations/') && tableOf(line) === table && !call.path.endsWith(line.slice(3)))
}

export const dent = defineMod({
  name: 'dent',
  setup(mod) {
    mod.use(permissions({
      deny: [
        { command: ['bun add', 'bun remove', 'bun install', 'bun update'], reason: 'Install inside the container: lando bun add.' },
        { command: ['npx', 'bunx', 'npm', 'yarn', 'node', 'tsc', 'vitest', 'php artisan'], reason: 'Use the project wrapper: bun run <script>.' },
        { write: ['tests/budgets.json', 'scripts/commands/test.ts', '.claude/settings.json', '.claude/skills/dent/**'], reason: 'The test gate does not change.' },
        { write: ['**/*.test.ts', '**/*.spec.ts', '**/*Test.php'], when: (call) => call.content !== undefined && addsSkip(call.previousContent, call.content), reason: 'Fix the test. Do not skip it.' },
        { write: ['**/*.test.ts', '**/*.spec.ts', '**/*Test.php'], when: (call) => call.content === undefined, reason: 'Change test files with Edit or Write, so the test gate can read the change.' },
        { command: 'bun test', when: (call) => call.commands.some(([name]) => ['tail', 'head', 'grep'].includes(name)), reason: 'Read the whole report: bun test --report=json.' },
        { write: 'Domain.md', when: async (_call, mod) => hasCodeChanges(await mod.process.run(['git', 'status', '--porcelain', '-uall'])), reason: 'Edit Domain.md in its own change, with the Architect.' },
        { write: 'database/migrations/*.php', when: async (call, mod) => duplicatesTable(call, mod), reason: 'Edit the uncommitted migration for this table.' },
      ],
    }))

    mod.use(check({ after: { write: ['**/*.ts', '**/*.tsx', '**/*.php'] }, run: ['bun', 'cli/dnt.ts', 'check'] }))
  },
})
