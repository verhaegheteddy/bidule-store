// Started by its command or its route: what a store's extension does at its simplest, its own command reading its
// own settings.
export async function activate(ctx) {
  ctx.commands.register('store-probe.greet', (args) => greeting(ctx.settings, args?.name))
}

// What the command and the route answer: the name given, else the one in its settings, in the tone of its settings.
export async function greeting(settings, name) {
  const who = name || String(await settings.get('store-probe.name'))
  const tone = String(await settings.get('store-probe.tone'))
  return { text: tone === 'warm' ? `Bonjour, cher ${who} !` : `Bonjour ${who}`, tone }
}
