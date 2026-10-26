/**
 * A class plugin reached through the module's DEFAULT export.
 *
 * cordis constructs a class plugin; calling one raises "Class constructor X
 * cannot be invoked without 'new'". The earlier class fix only covered values
 * handed to ctx.plugin(), so this shape still reached the call path.
 */
export const name = 'shape-default-class'
export const inject = ['tools']

export default class ShapeDefaultClass {
  constructor (ctx, config) {
    this.config = config
    ctx.tools.register({
      name: 'shape_default_class_tool',
      description: 'registered by a default-exported class constructor',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    })
  }
}
