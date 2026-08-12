import React from 'react'
import HookBoundary from './HookBoundary'

const registry = new Map()  // name -> [fn, ...]

export function registerHook(name, fn) {
  if (!registry.has(name)) registry.set(name, [])
  registry.get(name).push(fn)
}

// Expose for plugins to call without needing an SDK package
if (typeof window !== 'undefined') {
  window.__ymerflow_registerHook = registerHook
}

export function getHookFns(name) {
  return registry.get(name) || []
}

function rethrow(errors) {
  if (errors.length) {
    errors.slice(1).forEach(e => { e.cause = errors[0] })
    throw errors[errors.length - 1]
  }
}

function runSync(name, ...args) {
  const out = [], errors = []
  for (const fn of getHookFns(name)) {
    try { out.push(...(fn(...args) || [])) }
    catch (e) { errors.push(e) }
  }
  rethrow(errors)
  return out
}

async function runAsync(name, ...args) {
  const out = [], errors = []
  for (const fn of getHookFns(name)) {
    try { out.push(...((await fn(...args)) || [])) }
    catch (e) { errors.push(e) }
  }
  rethrow(errors)
  return out
}

function runJsx(name, ...args) {
  const out = []
  getHookFns(name).forEach((fn, i) => {
    let items
    try { items = fn(...args) || [] }
    catch (e) { console.error(`hook "${name}" #${i} threw`, e); return }
    items.forEach((item, j) => {
      if (React.isValidElement(item)) {
        const key = item.key ?? `${name}:${i}:${j}`
        out.push(<HookBoundary key={key} name={name}>{item}</HookBoundary>)
      } else {
        out.push(item)
      }
    })
  })
  return out
}

const ns = impl => new Proxy({}, { get: (_t, name) => (...args) => impl(name, ...args) })

export const hooks = {
  run:       ns(runSync),
  run_async: ns(runAsync),
  run_jsx:   ns(runJsx),
}

// Expose the hook runner to plugins via the window bridge (used by ymerflow-plugin-sdk).
if (typeof window !== 'undefined') {
  window.__ymerflow_hooks = hooks
}
