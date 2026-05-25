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
const CAMERA_SETTLE_MS = Number(process.env.UI_AUDIT_CAMERA_SETTLE_MS || 1800)

const tasks = [
  { id: 'operator_01_home_network_view', mode: 'operator', tab: 'Vue réseau', scope: 'national', description: "Vue d'accueil opérateur." },
  { id: 'operator_02_search_cell_results', mode: 'operator', tab: 'Vue réseau', scope: 'recherche', description: 'Recherche cellule visible.' },
  { id: 'operator_03_selected_cell_qos', mode: 'operator', tab: 'Qualité radio', scope: 'cellule', description: 'Cellule sélectionnée avec KPI QoS.' },
  { id: 'operator_04_peak_hours', mode: 'operator', tab: 'Heures critiques', scope: 'national/cellule', description: 'Vue heures critiques.' },
  { id: 'operator_05_forecast_qos', mode: 'operator', tab: 'Prévision QoS', scope: 'national/cellule', description: 'Vue prévision QoS.' },
  { id: 'operator_06_forecast_detail', mode: 'operator', tab: 'Prévision QoS', scope: 'cellule', description: 'Détail analyse assistée.' },
  { id: 'operator_07_action_cellule_ready', mode: 'operator', tab: 'Action cellule', scope: 'cellule', description: 'Actions simulables et état faisabilité.' },
  { id: 'operator_08_simulation_result_or_state', mode: 'operator', tab: 'Action cellule', scope: 'cellule', description: 'État résultat simulation ou indisponibilité.' },
  { id: 'operator_09_map_governorate_scope', mode: 'operator', tab: 'Vue réseau', scope: 'gouvernorat', description: 'Carte en scope gouvernorat.' },
  { id: 'operator_10_map_delegation_scope', mode: 'operator', tab: 'Vue réseau', scope: 'délégation', description: 'Carte en scope délégation.' },
  { id: 'admin_01_admin_mode_home', mode: 'admin', tab: 'Vue réseau', scope: 'national', description: 'Accueil mode admin.' },
  { id: 'admin_02_data_panel', mode: 'admin', tab: 'Données', scope: 'admin', description: 'Panneau données et qualité.' },
  { id: 'admin_03_import_dry_run', mode: 'admin', tab: 'Données', scope: 'admin', description: 'Zone import dry-run.' },
  { id: 'admin_04_export_controls', mode: 'admin', tab: 'Données', scope: 'admin', description: 'Contrôles export.' },
  { id: 'admin_05_system_status', mode: 'admin', tab: 'Système', scope: 'admin', description: 'Santé des services.' },
  { id: 'admin_06_forecast_debug', mode: 'admin', tab: 'Prévision QoS', scope: 'admin', description: 'Prévision avec détails techniques admin.' },
  { id: 'admin_07_jobs_health_or_simulation_admin', mode: 'admin', tab: 'Système/Action cellule', scope: 'admin', description: 'État jobs/simulation admin.' },
  { id: 'admin_08_map_layers_controls', mode: 'admin', tab: 'Vue réseau', scope: 'map-controls', description: 'Contrôles couches/métriques carte.' },
  { id: 'responsive_operator_tablet', mode: 'operator', tab: 'Vue réseau', scope: 'responsive-tablette', description: 'Vue tablette.' },
  { id: 'responsive_operator_mobile_or_narrow', mode: 'operator', tab: 'Vue réseau', scope: 'responsive-mobile', description: 'Vue mobile.' },
  { id: 'state_no_cell_selected', mode: 'operator', tab: 'Action cellule', scope: 'aucune cellule', description: 'État sans cellule sélectionnée.' },
  { id: 'state_forecast_insufficient_data', mode: 'operator', tab: 'Prévision QoS', scope: 'insuffisant', description: 'État données insuffisantes prévision.' },
  { id: 'state_simulation_unavailable', mode: 'operator', tab: 'Action cellule', scope: 'indisponible', description: 'État indisponibilité simulation.' },
]

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

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

async function resetOutput() {
  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(SHOTS_DIR, { recursive: true })
}

async function waitForMapSettled(page, { required = true } = {}) {
  try {
    await page.waitForFunction(() => {
      const fallback = document.querySelector('.map-fallback')
      if (fallback) return true
      const map = window.__netvisionMap
      const canvas = document.querySelector('.netvision-map-container canvas')
      return Boolean(
        map &&
        canvas &&
        canvas.clientWidth > 200 &&
        canvas.clientHeight > 200 &&
        map.isStyleLoaded?.() &&
        map.getLayer?.('admin-governorates-fill')
      )
    }, { timeout: required ? 60_000 : 20_000 })

    await page.evaluate(() => new Promise((resolve) => {
      const map = window.__netvisionMap
      if (!map || document.querySelector('.map-fallback')) {
        resolve()
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      map.once?.('idle', finish)
      window.setTimeout(finish, 5_000)
    }))
    await page.waitForTimeout(CAMERA_SETTLE_MS)
    return true
  } catch {
    return !required
  }
}

async function waitForVisualSettled(page, { map = false, requiredMap = false } = {}) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  if (map) await waitForMapSettled(page, { required: requiredMap })
  await page.waitForTimeout(350)
}

async function ensureAppIsUp(page) {
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.getByTestId('global-search-input').waitFor({ timeout: 30_000 })
    await waitForVisualSettled(page, { map: true, requiredMap: true })
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
  await waitForVisualSettled(page, { map: true, requiredMap: true })
}

async function clickTabIfExists(page, names, { waitMap = false } = {}) {
  for (const name of names) {
    const button = page.getByRole('button', { name })
    if (await button.first().isVisible().catch(() => false)) {
      await button.first().click()
      await waitForVisualSettled(page, { map: waitMap })
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
  await page.waitForTimeout(600)
  return page.locator('.search-popover button')
}

async function clickSearchResult(page, query, matcher) {
  const options = await openSearch(page, query)
  if (!(await options.first().isVisible().catch(() => false))) return false
  const count = await options.count()
  for (let i = 0; i < count; i += 1) {
    const candidate = options.nth(i)
    const text = cleanText(await candidate.innerText().catch(() => ''))
    if (matcher(text.toLowerCase())) {
      await candidate.click()
      await waitForVisualSettled(page, { map: true })
      return true
    }
  }
  await options.first().click()
  await waitForVisualSettled(page, { map: true })
  return true
}

async function findAndSelectCell(page, query = 'TN1158_c01') {
  return clickSearchResult(page, query, (text) => text.includes('tn1158_c01') && text.includes('cellule'))
}

async function selectForecastDetail(page) {
  const rows = page.locator('.site-table-card tbody tr')
  if (!(await rows.first().isVisible().catch(() => false))) return false
  await rows.first().click()
  await page.waitForTimeout(500)
  return true
}

async function capture(page, manifest, id, notes = '', options = {}) {
  const item = manifest.find((x) => x.id === id)
  if (!item) return false
  const filePath = path.join(SHOTS_DIR, `${id}.png`)
  try {
    await waitForVisualSettled(page, { map: Boolean(options.map), requiredMap: Boolean(options.requiredMap) })
    await page.screenshot({ path: filePath, fullPage: false })
    const stat = await fs.stat(filePath)
    item.captured = stat.size > 0
    item.filename = `screenshots/${id}.png`
    item.notes = notes
    return item.captured
  } catch (error) {
    item.captured = false
    item.notes = `${notes} | capture échouée: ${error.message}`
    return false
  }
}

function skip(manifest, id, notes) {
  const item = manifest.find((x) => x.id === id)
  if (item) {
    item.captured = false
    item.notes = notes
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
  const byPath = {}
  for (const req of requests) {
    byStatus[req.status] = (byStatus[req.status] || 0) + 1
    byPath[req.path] = (byPath[req.path] || 0) + 1
  }
  return {
    total_responses: requests.length,
    by_status: byStatus,
    top_paths: Object.entries(byPath)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([pathName, count]) => ({ path: pathName, count })),
    http_429_urls: requests.filter((r) => r.status === 429).map((r) => r.url),
  }
}

function generateReport({ manifest, consoleErrors, networkSummary, meta }) {
  const captured = manifest.filter((m) => m.captured)
  const operator = manifest.filter((m) => m.mode === 'operator')
  const admin = manifest.filter((m) => m.mode === 'admin')

  const renderSection = (entries) => entries.map((m) => {
    const shot = m.captured ? `![${m.id}](./${m.filename})` : '_Capture non disponible._'
    return `### ${m.id}
${shot}
- Ce que montre l'écran: ${m.description}
- Observations UX: ${m.notes || 'à compléter manuellement'}
- Friction visible: ${m.captured ? 'à confirmer après revue métier' : 'écran non capturé'}
- Prêt production: ${m.captured ? 'partiel (à valider)' : 'non évalué'}
`
  }).join('\n')

  return `# Audit visuel NetVision

## 1) Vue d'ensemble
- Date: ${meta.generatedAt}
- Branche/commit: ${meta.branch} / ${meta.commit}
- URL: ${meta.baseUrl}
- Viewport principal: ${meta.viewport}
- Mode de données: ${meta.dataMode}
- Captures obtenues: ${captured.length}/${manifest.length}
- Erreurs console: ${consoleErrors.length}
- Réponses 429: ${(networkSummary.by_status['429'] || 0)}

## 2) Inventaire flux opérateur
${renderSection(operator)}

## 3) Inventaire flux admin
${renderSection(admin)}

## 4) Cartographie navigation actuelle
- Onglets opérateur: Vue réseau, Heures critiques, Qualité radio, Action cellule, Prévision QoS.
- Mode admin: Données, Système, diagnostics de services, import/export et détails techniques.
- Recherche: champ global qui cible gouvernorat, délégation, site ou cellule.
- Carte: scope national, gouvernorat, délégation et cellule avec couches administratives et sites radio.

## 5) Inventaire fonctionnel
- Core opérateur: supervision carte, sélection cellule, QoS, heures critiques, simulation, prévision QoS.
- Avancé opérateur: analyse assistée, détails de crédibilité et calibration simulation.
- Admin/debug: mode données, import dry-run, export, santé services, jobs, diagnostics.
- Expérimental ou fragile: états d'indisponibilité simulation et états de données insuffisantes selon contexte.
- Fragmentation: panneaux admin très denses, plusieurs chemins pour atteindre les mêmes informations.

## 6) Problèmes UX observés
- La hiérarchie visuelle entre diagnostic, prévision et action reste trop plate.
- L'admin mélange qualité des données, ingestion, export et santé système dans des blocs denses.
- Certains états optionnels ne sont visibles que dans des conditions précises, donc difficiles à découvrir.
- La carte et les panneaux peuvent donner une impression de navigation parallèle plutôt qu'un flux unique.
- La version mobile expose vite les limites de densité des tableaux et contrôles.

## 7) Recommandations de refactor (sans implémentation)
- Espace Opérateur: Vue réseau, Priorités, Diagnostic cellule, Simulation.
- Espace Admin: Données, Services, Validation, Configuration.
- Créer une structure commune pour les états vides, bloqués, dégradés et indisponibles.
- Faire de chaque écran un choix principal clair: inspecter, prioriser, simuler ou administrer.
- Réserver les détails techniques au mode admin, avec une densité visuelle plus disciplinée.

## 8) Constats techniques bruts
- Erreurs console: ${consoleErrors.length}
- 429 détectés: ${(networkSummary.by_status['429'] || 0)}
- Endpoints les plus sollicités: ${networkSummary.top_paths.slice(0, 5).map((p) => `${p.path} (${p.count})`).join(', ') || 'n/a'}
`
}

async function gitValue(args, fallback = 'unknown') {
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile('git', args, { cwd: process.cwd() }, (error, stdout) => {
      if (error) resolve(fallback)
      else resolve(cleanText(stdout) || fallback)
    })
  })
}

async function main() {
  await resetOutput()
  const manifest = makeManifestTemplate()
  const consoleErrors = []
  const networkResponses = []

  const browser = await launchBrowser()
  const context = await browser.newContext({ viewport: VIEWPORT_DESKTOP })
  const page = await context.newPage()

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location(), ts: new Date().toISOString() })
    }
  })
  page.on('pageerror', (err) => {
    consoleErrors.push({ text: err.message, ts: new Date().toISOString() })
  })
  page.on('response', (response) => {
    try {
      const url = new URL(response.url())
      networkResponses.push({ url: response.url(), path: url.pathname, status: response.status() })
    } catch {}
  })

  const up = await ensureAppIsUp(page)
  if (!up) {
    await browser.close()
    throw new Error('Start the app with npm run dev before running npm run ui:audit.')
  }

  await setRole(page, 'operator')
  await clickTabIfExists(page, ['Vue réseau', 'Vue reseau'], { waitMap: true })
  await capture(page, manifest, 'operator_01_home_network_view', 'Landing opérateur capturé après chargement complet de la carte.', { map: true, requiredMap: true })

  await openSearch(page, 'TN1158_c01')
  await capture(page, manifest, 'operator_02_search_cell_results', 'Recherche cellule ouverte avec résultats visibles.', { map: true })

  const cellSelected = await findAndSelectCell(page)
  if (cellSelected) {
    await clickTabIfExists(page, ['Qualité radio', 'Qualite radio'])
    await capture(page, manifest, 'operator_03_selected_cell_qos', 'Cellule sélectionnée avec panneau QoS.', { map: true })
  } else {
    skip(manifest, 'operator_03_selected_cell_qos', 'Impossible de sélectionner TN1158_c01 via recherche.')
  }

  await clickTabIfExists(page, ['Heures critiques'])
  await capture(page, manifest, 'operator_04_peak_hours', 'État onglet heures critiques.')

  await clickTabIfExists(page, ['Prévision QoS', 'Prevision QoS'])
  await page.waitForTimeout(900)
  const forecastEmpty = await page.getByText(/Données temporelles insuffisantes/i).isVisible().catch(() => false)
  await capture(page, manifest, 'operator_05_forecast_qos', forecastEmpty ? 'État données insuffisantes.' : 'Table prévision visible.')
  if (forecastEmpty) {
    await capture(page, manifest, 'state_forecast_insufficient_data', 'Capture spécifique état insuffisant.')
  } else {
    skip(manifest, 'state_forecast_insufficient_data', 'État insuffisant non visible avec le dataset courant.')
  }

  if (await selectForecastDetail(page)) {
    await capture(page, manifest, 'operator_06_forecast_detail', 'Détail prévision après sélection ligne.')
  } else {
    skip(manifest, 'operator_06_forecast_detail', 'Aucune ligne prévision disponible.')
  }

  if (cellSelected) {
    await clickTabIfExists(page, ['Action cellule'])
    await capture(page, manifest, 'operator_07_action_cellule_ready', 'Panneau actions cellule.')
    await page.waitForTimeout(700)
    await capture(page, manifest, 'operator_08_simulation_result_or_state', 'État simulation (résultat, file ou blocage).')
  } else {
    skip(manifest, 'operator_07_action_cellule_ready', 'Cellule non sélectionnée.')
    skip(manifest, 'operator_08_simulation_result_or_state', 'Cellule non sélectionnée.')
  }

  await clickTabIfExists(page, ['Vue réseau', 'Vue reseau'], { waitMap: true })
  const govSelected = await clickSearchResult(page, 'Tunis', (text) => text.includes('gouvernorat') && text.includes('tunis'))
  if (govSelected) {
    await capture(page, manifest, 'operator_09_map_governorate_scope', 'Gouvernorat sélectionné via recherche, carte stabilisée.', { map: true })
  } else {
    skip(manifest, 'operator_09_map_governorate_scope', 'Gouvernorat non sélectionnable via recherche.')
  }
  const delegSelected = await clickSearchResult(page, 'El Menzah', (text) => text.includes('délégation') || text.includes('delegation') || text.includes('el menzah'))
  if (delegSelected) {
    await capture(page, manifest, 'operator_10_map_delegation_scope', 'Délégation sélectionnée via recherche, sites/cellules visibles si disponibles.', { map: true })
  } else {
    skip(manifest, 'operator_10_map_delegation_scope', 'Délégation non sélectionnable via recherche.')
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('global-search-input').waitFor({ timeout: 30_000 })
  await clickTabIfExists(page, ['Action cellule'])
  await capture(page, manifest, 'state_no_cell_selected', 'État Action cellule sans sélection.')
  if (await page.getByText(/Simulation indisponible|indisponible/i).isVisible().catch(() => false)) {
    await capture(page, manifest, 'state_simulation_unavailable', 'État indisponibilité visible.')
  } else {
    skip(manifest, 'state_simulation_unavailable', 'État indisponible non visible pendant la session.')
  }

  await setRole(page, 'admin')
  await capture(page, manifest, 'admin_01_admin_mode_home', 'Accueil admin après carte chargée.', { map: true, requiredMap: true })

  await clickTabIfExists(page, ['Données', 'Donnees'])
  await capture(page, manifest, 'admin_02_data_panel', 'Panneau Données.')
  await capture(page, manifest, 'admin_03_import_dry_run', 'Zone import/dry-run visible si présente.')
  await capture(page, manifest, 'admin_04_export_controls', 'Zone export visible si présente.')

  await clickTabIfExists(page, ['Système', 'System'])
  await capture(page, manifest, 'admin_05_system_status', 'État système/services.')
  await capture(page, manifest, 'admin_07_jobs_health_or_simulation_admin', 'Détails jobs/simulation admin.')

  await clickTabIfExists(page, ['Prévision QoS', 'Prevision QoS'])
  await page.waitForTimeout(900)
  await capture(page, manifest, 'admin_06_forecast_debug', 'Prévision avec métadonnées admin.')

  await clickTabIfExists(page, ['Vue réseau', 'Vue reseau'], { waitMap: true })
  await capture(page, manifest, 'admin_08_map_layers_controls', 'Contrôles carte admin après rendu carte.', { map: true })

  await page.setViewportSize(VIEWPORT_TABLET)
  await setRole(page, 'operator')
  await capture(page, manifest, 'responsive_operator_tablet', 'Rendu tablette après stabilisation.', { map: true })

  await page.setViewportSize(VIEWPORT_MOBILE)
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('global-search-input').waitFor({ timeout: 30_000 })
  await waitForVisualSettled(page, { map: true })
  await capture(page, manifest, 'responsive_operator_mobile_or_narrow', 'Rendu mobile étroit.', { map: true })

  const networkSummary = buildNetworkSummary(networkResponses)
  const branch = await gitValue(['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await gitValue(['rev-parse', '--short', 'HEAD'])
  const dataModeBadge = await page.getByText(/Jeu de démonstration|runtime_data_mock|Données non réelles/i).first().innerText().catch(() => 'non détecté')

  for (const item of manifest) {
    item.console_errors_count = consoleErrors.length
    item.network_429_count = networkSummary.by_status['429'] || 0
  }

  const report = generateReport({
    manifest,
    consoleErrors,
    networkSummary,
    meta: {
      generatedAt: new Date().toISOString(),
      branch,
      commit,
      baseUrl: BASE_URL,
      viewport: `${VIEWPORT_DESKTOP.width}x${VIEWPORT_DESKTOP.height}`,
      dataMode: cleanText(dataModeBadge),
    },
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
