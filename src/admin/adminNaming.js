function toCleanText(value, fallback = '') {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  return raw.replace(/\s+/g, ' ')
}

function smartTitleCase(value) {
  const cleaned = toCleanText(value)
  if (!cleaned) return ''
  return cleaned
    .split(' ')
    .map((word) => {
      if (!word) return word
      if (/^[A-Z0-9-]+$/.test(word)) return word
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`
    })
    .join(' ')
}

export function normalizeGovernorateName(value, fallback = 'Gouvernorat inconnu') {
  const cleaned = smartTitleCase(value)
  return cleaned || fallback
}

export function normalizeDelegationName(value, fallback = 'Delegation inconnue') {
  const cleaned = smartTitleCase(value)
  return cleaned || fallback
}

export function normalizeAdminNames(admin = {}) {
  if (!admin || typeof admin !== 'object') return admin
  return {
    ...admin,
    gov_name: normalizeGovernorateName(admin.gov_name),
    deleg_name: normalizeDelegationName(admin.deleg_name),
  }
}

