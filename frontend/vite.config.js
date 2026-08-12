import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'ymerflow_host',
      dts: false,
      remotes: {},
      // Shared singletons — one instance shared between host and all plugins.
      // react/react-dom must be singletons so hooks/context work across the host↔plugin boundary.
      // NOTE: gladly-plot is intentionally NOT shared here. The host subclasses gladly-plot base
      // classes (e.g. ArrayColumn, LayerType) at module-eval time, and @module-federation/vite does
      // not make a custom shared singleton synchronously available at eval (the base resolves to
      // undefined → "Class extends undefined"). Layer-type plugins that need the host's gladly
      // registry should import it via the host's window bridge rather than a shared singleton.
      shared: {
        react:                   { singleton: true, requiredVersion: '^18.2.0' },
        'react-dom':             { singleton: true, requiredVersion: '^18.2.0' },
        '@tanstack/react-query': { singleton: true },
      },
    }),
  ],
  build: {
    target: 'esnext',
  },
  server: {
    port: 3000,
  },
})
