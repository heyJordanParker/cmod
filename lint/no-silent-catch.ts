import { defineRule, type ESTree } from '@oxlint/plugins'

export const noSilentCatch = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a catch that never reads its error, so a permission error or a bug never reads as a missing file.' },
    messages: {
      dropped: 'This catch drops its error, so a permission error or a bug reads like the case it expects. Read the error and rethrow what it does not expect, as ifMissing does.',
    },
  },
  createOnce(context) {
    const readsError = (owner: ESTree.Node, error: ESTree.Node | null | undefined) => {
      if (error === null || error === undefined) return false
      if (error.type !== 'Identifier') return true
      const variable = context.sourceCode.getDeclaredVariables(owner).find((declared) => declared.name === error.name)
      return variable !== undefined && variable.references.length > 0
    }
    const marksHandled = (call: ESTree.Node) => {
      const parent = call.parent
      if (parent?.type === 'ExpressionStatement') return true
      return parent?.type === 'UnaryExpression' && parent.operator === 'void' && parent.parent?.type === 'ExpressionStatement'
    }
    return {
      CatchClause(node) {
        if (!readsError(node, node.param)) context.report({ node, messageId: 'dropped' })
      },
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression' || node.callee.property.type !== 'Identifier') return
        const method = node.callee.property.name
        const handler = method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined
        if (handler === undefined || (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression')) return
        if (method === 'catch' && marksHandled(node)) return
        if (!readsError(handler, handler.params[0])) context.report({ node: handler, messageId: 'dropped' })
      },
    }
  },
})
