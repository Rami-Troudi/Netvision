import fs from 'fs/promises'
import path from 'path'
import { chromium } from 'playwright'

const BASE_URL = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const OUT_DIR = path.resolve(process.cwd(), '.runtime', 'qa')
const REPORT_PATH = path.resolve(OUT_DIR, 'browser-qa-budget.json')

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  const timings = {}
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(err.message))

  const started = Date.now()
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.getByTestId('global-search-input').waitFor({ timeout: 60_000 })
  timings.initial_render_ms = Date.now() - started

  const searchStart = Date.now()
  await page.getByTestId('global-search-input').fill('TN1158_c01')
  const option = page.getByRole('option', { name: 'cell TN1158_c01 - Cellule' })
  await option.click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Ouvrir Action cellule' }).waitFor({ timeout: 30_000 })
  timings.search_to_cell_ms = Date.now() - searchStart

  await page.getByRole('button', { name: 'Ouvrir Action cellule' }).click()
  await page.getByTestId('queue-simulation').waitFor({ timeout: 30_000 })

  const timelineStart = Date.now()
  const slider = page.getByLabel('Chronologie')
  for (let i = 0; i < 10; i += 1) {
    await slider.fill(String(i + 1))
    await page.waitForTimeout(120)
  }
  timings.timeline_10_steps_ms = Date.now() - timelineStart

  const body = await page.locator('body').innerText()
  const result = {
    ok: consoleErrors.length === 0 && body.includes('Action cellule') && body.includes('TN1158_c01'),
    base_url: BASE_URL,
    timings,
    console_errors: consoleErrors,
    checked_at: new Date().toISOString(),
  }
  await fs.writeFile(REPORT_PATH, JSON.stringify(result, null, 2), 'utf8')
  await browser.close()
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
  console.log(`Browser QA passed: ${REPORT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
