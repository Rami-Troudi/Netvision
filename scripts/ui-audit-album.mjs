import fs from 'fs/promises'
import path from 'path'
import { chromium } from 'playwright'

const BASE_URL = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const OUT_DIR = path.resolve(process.cwd(), '.runtime', 'ui-audit')
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots')
const MANIFEST_PATH = path.join(OUT_DIR, 'ui-audit-manifest.json')
const REPORT_PATH = path.join(OUT_DIR, 'ui-audit-report.md')
const CONSOLE_PATH = path.join(OUT_DIR, 'console-errors.json')
const NETWORK_PATH = path.join(OUT_DIR, 'network-summary.json')

const VIEWPORT_DESKTOP = { width: 1600, height: 900 }
const VIEWPORT_TABLET = { width: 1024, height: 768 }
const VIEWPORT_MOBILE = { width: 390, height: 844 }

const tasks = [
  { id: 'operator_01_home_network_view', mode: 'operator', tab: 'Vue réseau', scope: 'national', description: "Vue d'accueil opérateur." },
  { id: 'operator_02_search_cell_results', mode: 'operator', tab: 'Vue réseau', scope: 'recherche', description: 'Recherche cellule visible.' },
  { id: 'operator_03_priorities', mode: 'operator', tab: 'Priorités', scope: 'national/cellule', description: 'Vue priorités réseau.' },
  { id: 'operator_04_cell_dossier', mode: 'operator', tab: 'Dossier cellule', scope: 'cellule', description: 'Dossier cellule avec KPI et diagnostic.' },
  { id: 'operator_05_simulation', mode: 'operator', tab: 'Simulation', scope: 'cellule', description: 'Simulation prête ou bloquée selon le contexte.' },
  { id: 'operator_06_governorate_scope', mode: 'operator', tab: 'Vue réseau', scope: 'gouvernorat', description: 'Carte en scope gouvernorat.' },
  { id: 'operator_07_delegation_scope', mode: 'operator', tab: 'Vue réseau', scope: 'délégation', description: 'Carte en scope délégation.' },
  { id: 'admin_01_data', mode: 'admin', tab: 'Données', scope: 'admin', description: 'Panneau Données.' },
  { id: 'admin_02_services', mode: 'admin', tab: 'Services', scope: 'admin', description: 'Panneau Services.' },
  { id: 'admin_03_validation', mode: 'admin', tab: 'Validation', scope: 'admin', description: 'Panneau Validation.' },
  { id: 'admin_04_configuration', mode: 'admin', tab: 'Configuration', scope: 'admin', description: 'Panneau Configuration.' },
  { id: 'responsive_operator_tablet', mode: 'operator', tab: 'Vue réseau', scope: 'responsive-tablette', description: 'Vue tablette.' },
  { id: 'responsive_operator_mobile_or_narrow', mode: 'operator', tab: 'Vue réseau', scope: 'responsive-mobile', description: 'Vue mobile.' },
]

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'msedge', headless: true })
  } catch {
    return chromium.launch({ headless: true })
  }
}

async function resetOutput() {
  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(SHOTS_DIR, { recursive: true })
}

async function waitForVisualSettled(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(300)
}

async function ensureAppIsUp(page) {
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.getByTestId('global-search-input').waitFor({ timeout: 30_000 })
    await waitForVisualSettled(page)
    return true
  } catch {
    return false
  }
}

async function setRole(page, mode) {
  await page.addInitScript((role) => {
    window.localStorage.setItem('netvision_role', role)
  }, mode === 'admin' ? 'admin' : 'operator')
  const url = mode === 'admin' ? `${BASE_URL}/?admin=1` : `${BASE_URL}/`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByTestId('global-search-input').waitFor({ timeout: 30_000 })
  await waitForVisualSettled(page)
}

async function clickTabIfExists(page, names) {
  for (const name of names) {
    const button = page.getByRole('button', { name })
    if (await button.first().isVisible().catch(() => false)) {
      await button.first().click()
      await waitForVisualSettled(page)
      return true
    }
  }
  return false
}

async function openSearch(page, query) {
  const input = page.getByTestId('global-search-input')
  await input.click()
  await input.fill('')
  await input.fill(query)
  await page.waitForTimeout(700)
}

async function clickSearchResult(page, query, matcher) {
  await openSearch(page, query)
  const options = page.locator('.search-popover button')
  if (!(await options.first().isVisible().catch(() => false))) return false
  const count = await options.count()
  for (let i = 0; i < count; i += 1) {
    const candidate = options.nth(i)
    const text = cleanText(await candidate.innerText().catch(() => ''))
    if (matcher(text.toLowerCase())) {
      await candidate.click()
      await waitForVisualSettled(page)
      return true
    }
  }
  return false
}

async function capture(page, manifest, id, notes = '') {
  const item = manifest.find((x) => x.id === id)
  if (!item) return false
  const filePath = path.join(SHOTS_DIR, `${id}.png`)
  try {
    await waitForVisualSettled(page)
    await page.screenshot({ path: filePath, fullPage: false })
    item.captured = true
    item.filename = `screenshots/${id}.png`
    item.notes = notes
    return true
  } catch (error) {
    item.captured = false
    item.notes = `${notes} | capture échouée: ${error.message}`
    return false
  }
}

function makeManifestTemplate() {
  return tasks.map((t) => ({
    id: t.id,
    filename: `screenshots/${t.id}.png`,
    mode: t.mode,
    tab: t.tab,
    scope: t.scope,
    description: t.description,
    captured: false,
    notes: '',
    console_errors_count: 0,
    network_429_count: 0,
  }))
}

function buildNetworkSummary(requests) {
  const byStatus = {}
  for (const req of requests) byStatus[req.status] = (byStatus[req.status] || 0) + 1
  return { total_responses: requests.length, by_status: byStatus, http_429_urls: requests.filter((r) => r.status === 429).map((r) => r.url) }
}

function renderSection(entries) {
  return entries.map((m) => {
    const shot = m.captured ? `![${m.id}](./${m.filename})` : '_Capture non disponible._'
    return `### ${m.id}\n${shot}\n- Ce que montre l'écran: ${m.description}\n- Observations UX: ${m.notes || 'à compléter manuellement'}\n`
  }).join('\n')
}

function generateReport({ manifest, consoleErrors, networkSummary, meta }) {
  const operator = manifest.filter((m) => m.mode === 'operator')
  const admin = manifest.filter((m) => m.mode === 'admin')
  const captured = manifest.filter((m) => m.captured)
  return `# Audit visuel NetVision\n\n## 1) Vue d'ensemble\n- Date: ${meta.generatedAt}\n- URL: ${meta.baseUrl}\n- Viewport principal: ${meta.viewport}\n- Captures obtenues: ${captured.length}/${manifest.length}\n- Erreurs console: ${consoleErrors.length}\n- Réponses 429: ${(networkSummary.by_status['429'] || 0)}\n\n## 2) Inventaire flux opérateur\n${renderSection(operator)}\n\n## 3) Inventaire flux admin\n${renderSection(admin)}\n\n## 4) Cartographie navigation actuelle\n- Onglets opérateur: Vue réseau, Priorités, Dossier cellule, Simulation.\n- Onglets admin: Données, Services, Validation, Configuration.\n`
}

async function main() {
  await resetOutput()
  const manifest = makeManifestTemplate()
  const consoleErrors = []
  const networkResponses = []

  const browser = await launchBrowser()
  const context = await browser.newContext({ viewport: VIEWPORT_DESKTOP })
  const page = await context.newPage()

  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push({ text: msg.text() }) })
  page.on('pageerror', (err) => consoleErrors.push({ text: err.message }))
  page.on('response', (response) => networkResponses.push({ url: response.url(), status: response.status() }))

  if (!(await ensureAppIsUp(page))) {
    await browser.close()
    throw new Error('Start the app with npm run dev before running npm run ui:audit.')
  }

  await setRole(page, 'operator')
  await clickTabIfExists(page, ['Vue réseau', 'Vue reseau'])
  await capture(page, manifest, 'operator_01_home_network_view', 'Vue réseau chargée.')
  await openSearch(page, 'TN1158_c01')
  await capture(page, manifest, 'operator_02_search_cell_results', 'Résultats de recherche visibles.')

  const selectedCell = await clickSearchResult(page, 'TN1158_c01', (text) => text.includes('tn1158_c01') && text.includes('cellule'))
  await clickTabIfExists(page, ['Priorités'])
  await capture(page, manifest, 'operator_03_priorities', selectedCell ? 'Priorités avec cellule sélectionnée.' : 'Priorités sans sélection cellule.')

  await clickTabIfExists(page, ['Dossier cellule'])
  await capture(page, manifest, 'operator_04_cell_dossier', 'Dossier cellule.')

  await clickTabIfExists(page, ['Simulation'])
  await capture(page, manifest, 'operator_05_simulation', 'Simulation.')

  await clickTabIfExists(page, ['Vue réseau', 'Vue reseau'])
  if (await clickSearchResult(page, 'Tunis', (text) => text.includes('gouvernorat') && text.includes('tunis'))) {
    await capture(page, manifest, 'operator_06_governorate_scope', 'Scope gouvernorat.')
  }
  if (await clickSearchResult(page, 'El Menzah', (text) => text.includes('délégation') || text.includes('delegation') || text.includes('el menzah'))) {
    await capture(page, manifest, 'operator_07_delegation_scope', 'Scope délégation.')
  }

  await setRole(page, 'admin')
  await clickTabIfExists(page, ['Données', 'Donnees'])
  await capture(page, manifest, 'admin_01_data', 'Admin données.')
  await clickTabIfExists(page, ['Services'])
  await capture(page, manifest, 'admin_02_services', 'Admin services.')
  await clickTabIfExists(page, ['Validation'])
  await capture(page, manifest, 'admin_03_validation', 'Admin validation.')
  await clickTabIfExists(page, ['Configuration'])
  await capture(page, manifest, 'admin_04_configuration', 'Admin configuration.')

  await page.setViewportSize(VIEWPORT_TABLET)
  await setRole(page, 'operator')
  await capture(page, manifest, 'responsive_operator_tablet', 'Rendu tablette.')

  await page.setViewportSize(VIEWPORT_MOBILE)
  await setRole(page, 'operator')
  await capture(page, manifest, 'responsive_operator_mobile_or_narrow', 'Rendu mobile.')

  const networkSummary = buildNetworkSummary(networkResponses)
  for (const item of manifest) {
    item.console_errors_count = consoleErrors.length
    item.network_429_count = networkSummary.by_status['429'] || 0
  }

  const report = generateReport({
    manifest,
    consoleErrors,
    networkSummary,
    meta: { generatedAt: new Date().toISOString(), baseUrl: BASE_URL, viewport: `${VIEWPORT_DESKTOP.width}x${VIEWPORT_DESKTOP.height}` },
  })

  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
  await fs.writeFile(CONSOLE_PATH, JSON.stringify(consoleErrors, null, 2), 'utf8')
  await fs.writeFile(NETWORK_PATH, JSON.stringify(networkSummary, null, 2), 'utf8')
  await fs.writeFile(REPORT_PATH, report, 'utf8')

  await browser.close()
  console.log(`UI audit generated in ${OUT_DIR}`)
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
