import puppeteer from 'puppeteer'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const browser = await puppeteer.launch()
const page = await browser.newPage()

page.on('pageerror', () => {})

await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' })

const schemas = await page.evaluate(() => {
  const widgets = window.__ymerflow_widgets
  if (!widgets) throw new Error('__ymerflow_widgets not found — is the dev server running?')
  const result = {}
  for (const [name, Widget] of Object.entries(widgets)) {
    result[name] = {
      title: Widget.title ?? name,
      schema: Widget.get_schema ? Widget.get_schema({}) : null,
      default: Widget.get_default ? Widget.get_default({}) : null,
    }
  }
  return result
})

await browser.close()

const outPath = resolve(__dirname, '../../backend/widget_schemas.json')
writeFileSync(outPath, JSON.stringify(schemas, null, 2))
console.log(`Written to ${outPath}`)
