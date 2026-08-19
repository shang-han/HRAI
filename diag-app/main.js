// Minimal test - runs inside Electron via default_app mechanism
// This file should be placed in diag-app/ and run with:
// electron.exe diag-app

// Try ALL possible ways to access Electron APIs

// Method 1: CJS require
try {
  var e1 = require('electron')
  console.log('[M1] require(electron) = ' + typeof e1)
} catch(e) { console.log('[M1] FAIL: ' + e.message) }

// Method 2: CJS require electron/main
try {
  var e2 = require('electron/main')
  console.log('[M2] require(electron/main) = ' + typeof e2)
} catch(e) { console.log('[M2] FAIL: ' + e.message) }

// Method 3: CJS require electron/renderer
try {
  var e3 = require('electron/renderer')
  console.log('[M3] require(electron/renderer) = ' + typeof e3)
} catch(e) { console.log('[M3] FAIL: ' + e.message) }

// Method 4: process._linkedBinding
try {
  var e4 = process._linkedBinding('electron_browser_app')
  console.log('[M4] _linkedBinding = ' + typeof e4)
} catch(e) { console.log('[M4] FAIL: ' + e.message) }

// Method 5: process.binding
try {
  var e5 = process.binding('electron_browser_app')
  console.log('[M5] process.binding = ' + typeof e5)
} catch(e) { console.log('[M5] FAIL: ' + e.message) }

// Summary
console.log('')
console.log('=== SUMMARY ===')
console.log('node: ' + process.version)
console.log('electron version: ' + process.versions.electron)
console.log('builtinModules with electron: ' + require('module').builtinModules.filter(function(m) { return m.indexOf('electron') >= 0 }).join(','))
console.log('_linkedBinding names:', Object.keys(process).filter(function(k) { return k.indexOf('linked') >= 0 || k.indexOf('binding') >= 0 }).join(','))

process.exit(0)
