import { API } from '../datamodel/api'

let mfInitialised = false

// One-time bare init of the module-federation runtime singleton with an EMPTY remote set.
// The current auth-appropriate remote set is registered on every loadPlugins() call via
// registerRemotes(), so an in-session auth transition can add/replace remotes in place —
// this must NOT freeze the remote set to the first call's plugins.
async function ensureInit() {
  if (mfInitialised) return
  const { init } = await import('@module-federation/runtime')
  await init({
    name: 'ymerflow_host',
    remotes: [],
    shared: {
      react:                   { version: '18.2.0', lib: () => import('react'),    singleton: true },
      'react-dom':             { version: '18.2.0', lib: () => import('react-dom'), singleton: true },
      'gladly-plot':           { version: '0.0.19', lib: () => import('gladly-plot'), singleton: true },
      '@tanstack/react-query': { version: '5.90.19', lib: () => import('@tanstack/react-query'), singleton: true },
    },
  })
  mfInitialised = true
}

export async function loadPlugins(plugins) {
  // Always init the runtime (even for an empty set) so a later authenticated reload can register
  // remotes into an already-initialized runtime. Do NOT early-return on empty here — that would
  // reintroduce a variant of the "first anonymous load freezes the remote set" bug.

  // Resolve relative base_url to absolute (needed in dev where frontend and backend are on different ports)
  const resolveUrl = (base_url) => {
    if (base_url.startsWith('http')) return base_url
    return API + base_url
  }

  // type: 'module' — plugins are built by @module-federation/vite as ES-module remotes
  // (remoteEntry.js uses `import` statements). The runtime must load them via dynamic import(),
  // not a classic <script> tag, or it fails with "Cannot use import statement outside a module".
  const remotes = (plugins || []).map(p => ({
    name: p.name,
    entry: resolveUrl(p.base_url) + 'remoteEntry.js',
    type: 'module',
  }))

  try {
    await ensureInit()
    const { registerRemotes, loadRemote } = await import('@module-federation/runtime')
    // force: true so an in-session logout→login (or a changed content hash) re-registers the
    // remote under the same name instead of being ignored as a duplicate.
    if (remotes.length) registerRemotes(remotes, { force: true })
    await Promise.all(
      (plugins || []).map(p =>
        loadRemote(`${p.name}/index`)
          .then(mod => {
            // New contract: a plugin registers its hooks in an exported init() that the host
            // calls on EVERY load. This is what makes re-registration survive the resetHooks()
            // that runs on each in-tab auth transition — a cached ESM remoteEntry is never
            // re-evaluated by the browser, so relying on module-top-level side effects loses the
            // hooks after the first load. Legacy plugins that registered at import time (no init
            // export) keep working via that side effect. See
            // docs/plans/done/plugin-init-function-registration.md.
            if (mod && typeof mod.init === 'function') mod.init()
          })
          .catch(e => console.warn(`Failed to load plugin ${p.name}:`, e))
      )
    )
  } catch (e) {
    console.warn('Plugin loading failed, continuing without plugins:', e)
  }
}
