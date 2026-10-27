/**
 * Fixture: TypeScript that strip-only erasure refuses.
 *
 * `constructor(private readonly tools)` is a parameter property. The compiler has
 * to erase the type AND emit the assignment, which "strip" mode does not do - it
 * refuses the file outright. A bridge that only strips therefore skips this file,
 * and the bundle arrives with no capabilities while looking like an empty plugin
 * rather than an uncompilable one. Measured on the real npm package `dshmarket`,
 * where five files are written this way.
 */
export const name = 'dsh-ts-params-fixture'
export const inject = ['tools']

interface ToolScope {
  register (def: unknown): void
}

class Registrar {
  constructor (private readonly tools: ToolScope) {}

  add (def: unknown): void {
    this.tools.register(def)
  }
}

export function apply (ctx: { tools: ToolScope }): void {
  new Registrar(ctx.tools).add({
    name: 'ts_param_echo',
    description: 'Echo from a TypeScript file that had to be rewritten.',
    parameters: { text: { type: 'string', description: 'text' } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (_a: unknown, v: { result: string }) => [{ type: 'text', text: v.result }],
    },
    execute: async (args: { text?: string }) => ({ ok: true, result: 'TS:' + (args.text ?? '') }),
  })
}
