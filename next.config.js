const path = require('path')
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } = require('next/constants')

/** @type {(phase: string) => import('next').NextConfig} */
module.exports = (phase) => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER
  const isBuild = phase === PHASE_PRODUCTION_BUILD

  return {
    reactStrictMode: true,
    // Keep dev and production artifacts separate so build verification cannot
    // corrupt a running dev server's hot-reload cache.
    distDir: process.env.NEXT_DIST_DIR || (isDev ? '.next-dev' : isBuild ? '.next-build' : '.next-build'),
    // Make tracing root explicit to silence workspace root warnings
    outputFileTracingRoot: path.join(__dirname),
  }
}
