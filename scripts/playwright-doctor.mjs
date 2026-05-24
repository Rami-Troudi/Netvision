import { chromium } from 'playwright'

async function main() {
  const startedAt = Date.now()
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge',
    headless: true,
  })
  const page = await browser.newPage()
  await page.goto('about:blank')
  await page.setContent('<main><h1>NetVision Playwright OK</h1></main>')
  const text = await page.locator('h1').textContent()
  await browser.close()

  if (text !== 'NetVision Playwright OK') {
    throw new Error('Playwright launched but could not read page content')
  }

  console.log(JSON.stringify({
    ok: true,
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge',
    elapsed_ms: Date.now() - startedAt,
  }, null, 2))
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge',
    message: error?.message || String(error),
  }, null, 2))
  process.exit(1)
})
