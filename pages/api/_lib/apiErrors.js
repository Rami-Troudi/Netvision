export const ERROR_TYPES = Object.freeze({
  VALIDATION: 'validation',
  DATA: 'data',
  ENGINE: 'engine',
  INFRA: 'infra',
})

export function sendApiError(res, status, type, message, detail = null) {
  return res.status(status).json({
    error: {
      type,
      message,
      detail: detail?.detail || detail || undefined,
      action: detail?.action || undefined,
    },
  })
}
