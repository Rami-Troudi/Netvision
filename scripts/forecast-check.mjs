import { spawn } from 'child_process'

const child = spawn('node', ['-e', `
  Promise.all([
    fetch('http://127.0.0.1:3000/api/forecast', { headers: { 'x-dev-bypass-auth': '1' } }),
    fetch('http://127.0.0.1:3000/api/drift', { headers: { 'x-dev-bypass-auth': '1' } })
  ])
  .then(async ([f, d]) => {
    const fj = await f.json().catch(() => ({}))
    const dj = await d.json().catch(() => ({}))
    const ok = f.ok && d.ok
    console.log(JSON.stringify({ ok, forecast: { status: f.status, available: fj.available, reason: fj.reason }, drift: { status: d.status, available: dj.available, reason: dj.reason } }, null, 2))
    process.exit(ok ? 0 : 1)
  })
  .catch(e => { console.error(e?.message || String(e)); process.exit(1) })
`], { stdio: 'inherit', shell: true })

child.on('exit', (code) => process.exit(code ?? 1))

