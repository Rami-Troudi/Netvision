import { getDataMode, setDataMode, DATA_MODES } from './_lib/dataMode'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ mode: getDataMode(), allowed: DATA_MODES })
  }
  if (req.method === 'POST') {
    const mode = String(req.body?.mode || '').trim().toLowerCase()
    if (!DATA_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${DATA_MODES.join(', ')}` })
    }
    return res.status(200).json(setDataMode(mode))
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
}
