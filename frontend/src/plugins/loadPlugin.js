import { API } from '../datamodel/api'

let mfInitialised = false

async function ensureInit(remotes) {
  if (mfInitialised) return
  const { init } = await import('@module-federation/runtime')
  await init({
    name: 'ymerflow_host',
    remotes,
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
  if (!plugins || plugins.length === 0) return

  // Resolve relative base_url to absolute (needed in dev where frontend and backend are on different ports)
  const resolveUrl = (base_url) => {
    if (base_url.startsWith('http')) return base_url
    return API + base_url
  }

  // type: 'module' — plugins are built by @module-federation/vite as ES-module remotes
  // (remoteEntry.js uses `import` statements). The runtime must load them via dynamic import(),
  // not a classic <script> tag, or it fails with "Cannot use import statement outside a module".
  const remotes = plugins.map(p => ({
    name: p.name,
    entry: resolveUrl(p.base_url) + 'remoteEntry.js',
    type: 'module',
  }))

  try {
    await ensureInit(remotes)
    const { loadRemote } = await import('@module-federation/runtime')
    await Promise.all(
      plugins.map(p =>
        loadRemote(`${p.name}/index`)
          .catch(e => console.warn(`Failed to load plugin ${p.name}:`, e))
      )
    )
  } catch (e) {
    console.warn('Plugin loading failed, continuing without plugins:', e)
  }
}
