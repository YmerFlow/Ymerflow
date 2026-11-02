import puppeteer from 'puppeteer'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const browser = await puppeteer.launch()
const page = await browser.newPage()

page.on('pageerror', () => {})

await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' })

// The frontend owns the workspace-layout schema and builds it whole — one full recursive
// JSON Schema document for the entire layout tree (see flexout/workspaceSchema.js). We just
// dump it; the backend MCP tools slice it. Filename stays widget_schemas.json for historical
// path stability even though it now holds the full workspace schema.
const schema = await page.evaluate(() => {
  const doc = window.__ymerflow_workspace_schema
  if (!doc) throw new Error('__ymerflow_workspace_schema not found — is the dev server running?')
  return doc
})

await browser.close()

const outPath = resolve(__dirname, '../../backend/widget_schemas.json')
writeFileSync(outPath, JSON.stringify(schema, null, 2))
console.log(`Written to ${outPath}`)
