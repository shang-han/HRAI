// Build: esbuild for main process + preload (CJS output)
import * as esbuild from 'esbuild'

const externals = [
  'electron', 'electron/main', 'electron/common', 'electron/renderer',
  'path', 'fs', 'child_process', 'http', 'https', 'crypto', 'os',
  'url', 'module', 'stream', 'util', 'events', 'net', 'tls',
  'zlib', 'buffer', 'querystring',
  'electron-store', 'winston', 'node-machine-id', 'systeminformation',
]

// Main process - CJS
await esbuild.build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist-electron/main.js',
  external: externals,
  sourcemap: true,
})
console.log('main.js built (CJS)')

// Preload - CJS
await esbuild.build({
  entryPoints: ['electron/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist-electron/preload.js',
  external: ['electron'],
})
console.log('preload.js built (CJS)')
