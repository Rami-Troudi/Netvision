import fs from 'fs/promises'
import path from 'path'

const ROOTS = ['src', 'scripts', 'docs']
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.css', '.md'])
const SKIP_DIRS = new Set(['node_modules', '.next', '.runtime', 'coverage'])
const SKIP_FILES = new Set([
  path.normalize('scripts/check-mojibake.mjs'),
  path.normalize('scripts/ns3-prereq-check.mjs'),
  path.normalize('docs/ui-refactor-investigation.md'),
])

const PATTERNS = [
  /Ã|Â|�/,
  /r\?seau/i,
  /Priorit\?/i,
  /Donn\?/i,
  /Qualit\?/i,
  /Pr\?vision/i,
  /d\?gradation/i,
  /op\?rateur/i,
  /p\?rim/i,
  /v\?rifier/i,
  /s\?lection/i,
  /r\?current/i,
]

async function walk(dir, files = []) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, files)
    else if (EXTENSIONS.has(path.extname(entry.name))) files.push(full)
  }
  return files
}

function isFinding(line) {
  return PATTERNS.some((pattern) => pattern.test(line))
}

const findings = []
for (const root of ROOTS) {
  const files = await walk(path.resolve(process.cwd(), root))
  for (const file of files) {
    const rel = path.normalize(path.relative(process.cwd(), file))
    if (SKIP_FILES.has(rel)) continue
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    text.split(/\r?\n/).forEach((line, index) => {
      if (isFinding(line)) findings.push({ file: rel, line: index + 1, text: line.trim().slice(0, 220) })
    })
  }
}

if (findings.length) {
  console.error('Mojibake or broken French accent artifacts found:')
  for (const item of findings.slice(0, 80)) console.error(`${item.file}:${item.line}: ${item.text}`)
  if (findings.length > 80) console.error(`... ${findings.length - 80} more`)
  process.exit(1)
}

console.log('No mojibake artifacts found in src/, scripts/, docs/.')
