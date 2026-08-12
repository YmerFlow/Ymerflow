import TestFrontendWidget from './TestFrontendWidget'

// Register widget via the host's window global (set by hooks.js before plugin loading)
if (typeof window !== 'undefined' && window.__ymerflow_registerHook) {
  window.__ymerflow_registerHook('widgets', () => [
    { name: 'TestFrontendWidget', component: TestFrontendWidget },
  ])
} else {
  console.error('[test-frontend-plugin] window.__ymerflow_registerHook not available')
}
