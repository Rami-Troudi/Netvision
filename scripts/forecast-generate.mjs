import { spawn } from 'child_process'

const days = Math.max(1, Math.min(7, Number.parseInt(process.argv[2] || '1', 10) || 1))

const child = spawn('node', ['-e', `
  fetch('http://127.0.0.1:3000/api/forecast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dev-bypass-auth': '1' },
    body: JSON.stringify({ days: ${days} })
  })
  .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, body: j })))
  .then(o => { console.log(JSON.stringify(o, null, 2)); process.exit(o.ok ? 0 : 1) })
  .catch(e => { console.error(e?.message || String(e)); process.exit(1) })
`], { stdio: 'inherit', shell: true })

child.on('exit', (code) => process.exit(code ?? 1))

