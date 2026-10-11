import { defineRule } from '@oxlint/plugins'

export const programOwner = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Start each outside program from the one file that owns it, so a change in how the program behaves has one place to fix.' },
    messages: {
      owned: 'Only {{owner}} starts {{program}}. Call a function there, or add one.',
    },
    schema: [{ type: 'object', additionalProperties: { type: 'string' } }],
  },
  create(context) {
    const owners = (context.options[0] ?? {}) as Readonly<Record<string, string>>
    return {
      ArrayExpression(node) {
        const first = node.elements[0]
        if (first?.type !== 'Literal' || typeof first.value !== 'string') return
        const owner = owners[first.value]
        if (owner === undefined || context.filename.endsWith(`/${owner}`)) return
        context.report({ node, messageId: 'owned', data: { owner, program: first.value } })
      },
    }
  },
})
