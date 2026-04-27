let worker = null
let seq = 0
const pending = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker('/workers/dataWorker.js')
  worker.onmessage = (event) => {
    const { id, ok, data, error } = event.data || {}
    const item = pending.get(id)
    if (!item) return
    pending.delete(id)
    clearTimeout(item.timer)
    ok ? item.resolve(data) : item.reject(new Error(error || 'Worker request failed'))
  }
  worker.onerror = (event) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error(event?.message || 'Data worker crashed'))
    }
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

export function callImportWorker(action, payload, timeoutMs = 60000) {
  const target = getWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${action} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    target.postMessage({ id, action, payload })
  })
}

export function buildAutoMapping(headers = [], inferredMapping = {}) {
  const mapping = {}
  Object.entries(inferredMapping || {}).forEach(([field, header]) => {
    if (headers.includes(header)) mapping[field] = header
  })
  return mapping
}
