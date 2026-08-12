import ClusterTestWidget from './Widget'

// Registers the widget via the host's window bridge (set before plugins load).
if (typeof window !== 'undefined' && window.__ymerflow_registerHook) {
  window.__ymerflow_registerHook('widgets', () => [
    { name: 'ClusterTestWidget', component: ClusterTestWidget },
  ])
} else {
  console.error('[cluster-test-widget] window.__ymerflow_registerHook not available')
}
