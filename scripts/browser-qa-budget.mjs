import fs from 'fs/promises'
import path from 'path'
import { chromium } from 'playwright'

const BASE_URL = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const FALLBACK_BASE_URLS = process.env.NEXT_BASE_URL ? [] : ['http://127.0.0.1:3001']
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

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

async function captureDebug(page, reason) {
  const debugScreenshot = path.resolve(OUT_DIR, 'browser-qa-search-debug.png')
  const debugText = path.resolve(OUT_DIR, 'browser-qa-search-debug.txt')
  await page.screenshot({ path: debugScreenshot, fullPage: false }).catch(() => {})
  const bodyText = await page.locator('body').innerText().catch(() => '')
  await fs.writeFile(debugText, `${reason}\n\n${bodyText.slice(0, 6000)}`, 'utf8').catch(() => {})
  return { debug_screenshot: debugScreenshot, debug_text: debugText }
}

async function selectSearchResult(page, query, matcher) {
  const input = page.getByTestId('global-search-input')
  await input.click()
  await input.fill('')
  await input.fill(query)

  let visibleCandidates = 0
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidateGroups = [
      page.locator('.search-popover button'),
      page.getByRole('option'),
      page.getByText(query, { exact: false }),
    ]

    for (const locator of candidateGroups) {
      const count = await locator.count().catch(() => 0)
      visibleCandidates = Math.max(visibleCandidates, count)
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i)
        if (!(await candidate.isVisible().catch(() => false))) continue
        const text = cleanText(await candidate.innerText().catch(() => ''))
        if (matcher(text.toLowerCase())) {
          await candidate.click({ timeout: 30_000 })
          return { clicked: true, text }
        }
      }
    }
    await page.waitForTimeout(250)
  }

  const debug = await captureDebug(page, `Search result not found for ${query}; visible candidate count ${visibleCandidates}`)
  return { clicked: false, reason: `Search result not found for ${query}`, ...debug }
}

async function clickButtonContaining(page, fragments, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  const normalize = (value) => cleanText(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
  const wanted = fragments.map(normalize)

  while (Date.now() < deadline) {
    const buttons = await page.locator('button').all()
    for (const button of buttons) {
      if (!(await button.isVisible().catch(() => false))) continue
      const text = normalize(await button.innerText().catch(() => ''))
      if (wanted.some((fragment) => text.includes(fragment))) {
        await button.click({ timeout: 30_000 })
        return { clicked: true, text }
      }
    }
    await page.waitForTimeout(250)
  }

  const debug = await captureDebug(page, `Button not found for fragments: ${fragments.join(', ')}`)
  return { clicked: false, reason: `Button not found for fragments: ${fragments.join(', ')}`, ...debug }
}

async function waitForDashboardData(page) {
  await page.waitForFunction(() => {
    const body = document.body.innerText || ''
    const loading = body.includes('Chargement des données runtime') ||
      body.includes('Chargement des donnees runtime')
    const hasTimeline = /\b[1-9]\d*\s+tranches\b/i.test(body)
    const hasDashboardShell = body.includes('Réseau mobile Tunisie') ||
      body.includes('Vue réseau') ||
      body.includes('Vue reseau')
    return !loading && hasTimeline && hasDashboardShell
  }, null, { timeout: 90_000 })
  await page.locator('.netvision-map-container canvas').first().waitFor({ timeout: 90_000 }).catch(() => {})
  await page.waitForTimeout(500)
}

async function failWithReport(browser, payload) {
  await fs.writeFile(REPORT_PATH, JSON.stringify(payload, null, 2), 'utf8')
  await browser.close()
  console.error(JSON.stringify(payload, null, 2))
  process.exit(1)
}

async function gotoRunningApp(page) {
  const candidates = [BASE_URL, ...FALLBACK_BASE_URLS]
  let lastError = null
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return url
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
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
    if (response.status() === 429) http429.push(response.url())
  })

  const started = Date.now()
  const activeBaseUrl = await gotoRunningApp(page)
  await page.getByTestId('global-search-input').waitFor({ timeout: 60_000 })
  await waitForDashboardData(page)
  timings.initial_render_ms = Date.now() - started

  const searchStart = Date.now()
  const searchResult = await selectSearchResult(page, 'TN1158_c01', (text) => text.includes('tn1158_c01'))
  if (!searchResult.clicked) {
    await failWithReport(browser, {
      ok: false,
      base_url: activeBaseUrl,
      error: searchResult.reason,
      debug_screenshot: searchResult.debug_screenshot,
      debug_text: searchResult.debug_text,
      checked_at: new Date().toISOString(),
    })
  }
  const prepareButton = await clickButtonContaining(page, ['preparer simulation'])
  if (!prepareButton.clicked) {
    await failWithReport(browser, {
      ok: false,
      base_url: activeBaseUrl,
      error: prepareButton.reason,
      debug_screenshot: prepareButton.debug_screenshot,
      debug_text: prepareButton.debug_text,
      checked_at: new Date().toISOString(),
    })
  }
  timings.search_to_cell_ms = Date.now() - searchStart

  await page.getByTestId('queue-simulation').waitFor({ timeout: 30_000 })
  const simMapCount = await page.locator('.map-card').count()
  if (simMapCount !== 0) {
    await failWithReport(browser, {
      ok: false,
      base_url: activeBaseUrl,
      error: 'Map should be hidden in Simulation tab',
      checked_at: new Date().toISOString(),
    })
  }

  const forecastStart = Date.now()
  const forecastTab = await clickButtonContaining(page, ['Priorit'])
  if (!forecastTab.clicked) {
    await failWithReport(browser, {
      ok: false,
      base_url: activeBaseUrl,
      error: forecastTab.reason,
      debug_screenshot: forecastTab.debug_screenshot,
      debug_text: forecastTab.debug_text,
      checked_at: new Date().toISOString(),
    })
  }
  await page.waitForFunction(() => {
    const body = (document.body.innerText || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    return body.includes('risque estime') ||
      body.includes('donnees temporelles insuffisantes') ||
      body.includes('prevision indicative') ||
      body.includes('priorites reseau') ||
      body.includes('a traiter maintenant') ||
      body.includes('signaux observes') ||
      body.includes('risque prochain horizon')
  }, null, { timeout: 30_000 })
  const prioritiesMapCount = await page.locator('.map-card').count()
  if (prioritiesMapCount < 1) {
    await failWithReport(browser, {
      ok: false,
      base_url: activeBaseUrl,
      error: 'Map should be visible in Priorités tab',
      checked_at: new Date().toISOString(),
    })
  }
  if (await page.getByText(/Risque indicatif prochain horizon|Risque estim/i).isVisible().catch(() => false)) {
    const firstForecastRow = page.locator('.site-table-card tbody tr').first()
    await firstForecastRow.click({ timeout: 30_000 })
    await page.getByRole('button', { name: /Ouvrir le dossier/i }).waitFor({ timeout: 30_000 })
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
  const normalizedBody = body.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const result = {
    ok: blockingConsoleErrors.length === 0 &&
      blocking429.length === 0 &&
      (normalizedBody.includes('priorit') || normalizedBody.includes('dossier cellule') || normalizedBody.includes('simulation')) && normalizedBody.includes('tn1158_c01'),
    base_url: activeBaseUrl,
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

