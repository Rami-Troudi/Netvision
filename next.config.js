/** @type {import('next').NextConfig} */
const path = require('path')

const nextConfig = {
  reactStrictMode: true,
  // Use a fresh dist directory to avoid OneDrive-locked build/trace
  distDir: '.next-dev',
  // Make tracing root explicit to silence workspace root warnings
  outputFileTracingRoot: path.join(__dirname),
}

module.exports = nextConfig
