import fs from 'fs/promises'
import path from 'path'
import { chromium } from 'playwright'

const BASE_URL = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const OUT_DIR = path.resolve(process.cwd(), '.runtime', 'qa')
const REPORT_PATH = path.resolve(OUT_DIR, 'browser-qa-budget.json')
const CORE_429_PATHS = ['/api/data', '/api/peak-hours', '/api/recommend', '/api/jobs', '/api/jobs-health', '/api/forecast']

async function launchBrowser() {
  const preferredChannel = process.env.PW_CHANNEL || ''
  if (preferredChannel) {
    try {
      return await chromium.launch({ channel: preferredChannel, headless: true })
    } catch {}
  }
  try {
    return await chromium.launch({ channel: 'msedge', headless: true })
  } catch {
    return chromium.launch({ headless: true })
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  const http429 = []
  const timings = {}
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  page.on('response', (response) => {
    if (response.status() === 429) {
      http429.push(response.url())
    }
  })

  const started = Date.now()
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.getByTestId('global-search-input').waitFor({ timeout: 60_000 })
  timings.initial_render_ms = Date.now() - started

  const searchStart = Date.now()
  await page.getByTestId('global-search-input').fill('TN1158_c01')
  const options = page.locator('.search-popover button')
  await options.first().waitFor({ timeout: 30_000 })
  const optionCount = await options.count()
  let clicked = false
  for (let i = 0; i < optionCount; i += 1) {
    const candidate = options.nth(i)
    const text = (await candidate.innerText()).toLowerCase()
    if (text.includes('tn1158_c01')) {
      await candidate.click({ timeout: 30_000 })
      clicked = true
      break
    }
  }
  if (!clicked) await options.first().click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Ouvrir Action cellule' }).waitFor({ timeout: 30_000 })
  timings.search_to_cell_ms = Date.now() - searchStart

  await page.getByRole('button', { name: 'Ouvrir Action cellule' }).click()
  await page.getByTestId('queue-simulation').waitFor({ timeout: 30_000 })

  const forecastStart = Date.now()
  await page.getByRole('button', { name: /Prévision QoS|Prevision QoS/ }).click()
  await Promise.race([
    page.getByText('Risque estimé').waitFor({ timeout: 30_000 }),
    page.getByText('Données temporelles insuffisantes').waitFor({ timeout: 30_000 }),
  ])
  if (await page.getByText('Risque estimé').isVisible().catch(() => false)) {
    const firstForecastRow = page.locator('.site-table-card tbody tr').first()
    await firstForecastRow.click({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Ouvrir Qualité radio' }).waitFor({ timeout: 30_000 })
  }
  timings.forecast_open_ms = Date.now() - forecastStart

  const timelineStart = Date.now()
  const slider = page.getByLabel('Chronologie')
  for (let i = 0; i < 10; i += 1) {
    await slider.fill(String(i + 1))
    await page.waitForTimeout(120)
  }
  timings.timeline_10_steps_ms = Date.now() - timelineStart

  const body = await page.locator('body').innerText()
  const tolerated429Errors = consoleErrors.filter((text) => /429 \(Too Many Requests\)/i.test(text))
  const blockingConsoleErrors = consoleErrors.filter((text) => !/429 \(Too Many Requests\)/i.test(text))
  const unique429 = Array.from(new Set(http429))
  const blocking429 = unique429.filter((url) => {
    const pathname = new URL(url).pathname
    return CORE_429_PATHS.some((corePath) => pathname === corePath || pathname.startsWith(`${corePath}/`))
  })
  const tolerated429 = unique429.filter((url) => !blocking429.includes(url))
  const result = {
    ok: blockingConsoleErrors.length === 0 && blocking429.length === 0 && body.includes('Prévision') && body.includes('TN1158_c01'),
    base_url: BASE_URL,
    timings,
    console_errors: blockingConsoleErrors,
    tolerated_console_errors: tolerated429Errors,
    http_429_urls: unique429,
    blocking_429_urls: blocking429,
    tolerated_429_urls: tolerated429,
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
