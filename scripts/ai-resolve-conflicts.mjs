#!/usr/bin/env node
// AI-resolve git merge conflicts using Claude Opus, optionally proxied
// through a Cloudflare AI Gateway for caching + analytics.
//
// Used by .github/workflows/upstream-sync.yml: when a `git merge --squash
// -X subtree=PKG upstream/main` produces conflicts, this script reads each
// conflicted file, sends it to Claude with a context-rich system prompt
// describing this fork's local additions, and writes back the resolved
// content. The workflow then commits + opens a PR labelled [AI] for human
// review.
//
// Why this works for our fork specifically:
//   - We have a small set of well-defined local additions (debrid module,
//     RPC toggle, settings injection, patched-Electron scripts, version
//     bumps) that should ALWAYS be preserved
//   - Upstream additions on the same files should ALWAYS be incorporated
//   - The conflict patterns are predictable: most are "we added X near
//     where they added Y" where both can coexist
//
// Cloudflare AI Gateway setup (optional - script falls back to direct
// api.anthropic.com if CF_AI_GATEWAY_URL isn't set):
//   1. Create a Gateway at https://dash.cloudflare.com/<acct>/ai/ai-gateway
//   2. Use BYOK mode with your Anthropic API key
//   3. Copy the universal endpoint URL: https://gateway.ai.cloudflare.com/
//      v1/<account_id>/<gateway_id>/anthropic
//   4. Add as GitHub Actions secret CF_AI_GATEWAY_URL
//   5. Also add ANTHROPIC_API_KEY (used as x-api-key header when calling
//      through the gateway - CF Gateway forwards it to Anthropic)
//
// Required env:
//   ANTHROPIC_API_KEY     - your Anthropic key (sk-ant-...)
// Optional env:
//   CF_AI_GATEWAY_URL     - Cloudflare AI Gateway base URL (without
//                           trailing /anthropic - we append /anthropic/v1/messages)
//   ANTHROPIC_MODEL       - model id (default: claude-opus-4-5)
//   ANTHROPIC_MAX_TOKENS  - max output tokens (default: 32000)
//
// Usage:
//   node scripts/ai-resolve-conflicts.mjs <package-name> <file1> <file2> ...
//
// The first arg names which sub-package the conflicts are in - it scopes
// the system prompt's context to just the relevant fork additions.

import { readFileSync, writeFileSync } from 'node:fs'
import { argv, env, exit } from 'node:process'

const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
const CF_AI_GATEWAY_URL = env.CF_AI_GATEWAY_URL
const MODEL = env.ANTHROPIC_MODEL ?? 'claude-opus-4-5'
const MAX_TOKENS = Number(env.ANTHROPIC_MAX_TOKENS ?? 32000)

if (!ANTHROPIC_API_KEY) {
  console.error('ai-resolve: ANTHROPIC_API_KEY env var is required')
  exit(1)
}

// CF Gateway URL pattern: https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic
// Gateway-prefixed endpoint forwards x-api-key + body to Anthropic, returns
// the same response shape. Direct fallback uses api.anthropic.com.
const ENDPOINT = CF_AI_GATEWAY_URL
  ? `${CF_AI_GATEWAY_URL.replace(/\/$/, '')}/v1/messages`
  : 'https://api.anthropic.com/v1/messages'

// Per-package context: tells Claude what fork-only additions to preserve.
// Keep these short - they're the "what to NOT lose" cheat sheet.
const PACKAGE_CONTEXT = {
  electron: `Fork-only additions in this package:
- electron/src/main/extras-window.ts: standalone Hayase+ Extras settings window
- electron/src/main/app.ts: HAYASE_INJECT block (~400 lines) with injectDebrid + injectRpcMaster + injectCheckUpdate, BUNNY_DISABLE_INJECT one-shot, debrid stream proxy webRequest comment, BASE_URL HAYASE_BASE_URL env var, AudioVideoTracks comment, "Hayase+ Extras" tray menu entry, applyStoredExtrasOnStartup wiring on torrent process spawn
- electron/src/main/discord.ts: enabled flag, #reconnectTimer, setEnabled() method, RPC enabled-checks
- electron/src/main/ipc.ts: WHITELISTED_URLS additions for debrid domains, extras-merging in updateSettings, toggleDiscordRPC + openExtras + getExtras + applyExtras + checkDebridKey methods, updateReady() isUpdateAvailable check
- electron/src/main/store.ts: extras: { enableRPC, showDetailsInRPC, debridProvider, debridApiKey } block + ExtrasSettings export
- electron/src/main/index.ts: app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')
- electron/src/preload/index.ts: toggleDiscordRPC, openExtras, getExtras, setExtras, testDebridKey, checkDebrid native API exposures
- electron/electron-builder.yml: aggressive node_modules file exclusions, publish: nickEatsBread/hayase, afterPack hook, electronDist: node_modules/electron/dist, AC3/EAC3/proprietary-codec related comments
- electron/electron.vite.config.ts: resolvePackageRoot helper, ENABLE_BYTECODE existsSync gate, dual-input preload (index + extras)
- electron/dev-app-update.yml: provider: github / nickEatsBread / hayase
- electron/package.json: version 6.4.x (above upstream's), native: workspace:* + torrent-client: workspace:*, codecs:install / codecs:restore scripts`,
  'torrent-client': `Fork-only additions in this package:
- torrent-client/debrid/ directory: Real-Debrid / AllDebrid / Premiumize / TorBox provider implementations
- torrent-client/index.ts: DebridProvider import, HTTP/HTTPS keep-alive Agents, debrid Symbols, VIDEO_MIME_BY_EXT, DebridStats interface, this[debrid]/[debridProxy]/[debridStats] instance fields, _setDebrid wiring in constructor + updateSettings, public checkDebrid method, playTorrent's debrid short-circuit, _playDebrid + _ensureDebridProxy + _buildDebridProxyUrl + _handleDebridProxy + _streamToAsyncIterable + _toDebridSource + _guessMime methods, debrid-aware torrentInfo / peerInfo / fileInfo / protocolStatus fallback paths, _makeDebridStats helper, debridProxy cleanup in destroy()
- torrent-client/attachments.ts: DebridFile class (async-iterable file-like for matroska-metadata over debrid HTTP), debridUrlToKey Map + clear() in register(), registerDebrid + feedDebrid methods
- torrent-client/package.json: native: workspace:* (NOT github:hayase-app/native)`,
  native: `Fork-only additions in this package:
- native/index.ts:
  - DebridProviderId type ('none' | 'realdebrid' | 'alldebrid' | 'premiumize' | 'torbox')
  - DebridSettings interface (debridProvider + debridApiKey)
  - DebridStatus interface (provider, user, premium, expiration?)
  - TorrentSettings extends DebridSettings (NOT just standalone)
  - Native.toggleDiscordRPC method
  - Native.checkDebrid method`,
  interface: `Fork-only additions in this package:
- interface/package.json: native: workspace:* (NOT github:hayase-app/native), version stays at upstream's value (we don't fork interface UI)
- This package is NOT deployed (production loads UI from https://hayase.app/), so for runtime files prefer upstream's version verbatim`,
  capacitor: `No fork-only additions in this package - take upstream verbatim.`,
  wiki: `No fork-only additions in this package - take upstream verbatim.`,
  'free-torrents': `No fork-only additions in this package - take upstream verbatim.`
}

const SYSTEM_PROMPT_TEMPLATE = (pkg, perPkgContext) => `You are resolving a git merge-squash conflict in a fork of hayase-app.

# About this fork (nickEatsBread/hayase)
Personal fork of hayase-app monorepo. Adds: debrid streaming (Real-Debrid / AllDebrid / Premiumize / TorBox via localhost HTTP proxy), Discord RPC master toggle (upstream removed), settings injection into hayase.app's UI, patched-Electron with proprietary codecs, Check For Update button, bundle-size optimisations, GitHub Actions sync workflow.

# Conflicts in package: ${pkg}

${perPkgContext}

# Resolution rules

1. PRESERVE every fork-only addition listed above. If you see one of those in HEAD (the <<<<<<< HEAD side) and not in upstream (the >>>>>>> side), keep HEAD's version.

2. INCORPORATE every upstream-only addition. If you see new fields/methods/imports/dependencies/parameters in upstream that aren't in HEAD, fold them into the resolved file - even when they're inside a hunk that mostly matches HEAD.

3. For function signature changes upstream made (e.g. added a new parameter or changed a parameter type): update fork's overrides + call sites to match. Do not silently keep the old signature.

4. For renamed identifiers in upstream: rename in fork's code that references them too.

5. For shared sections that BOTH sides modified: take upstream's structural change as the base, then re-apply fork's intent on top. Example: if both sides reformatted the same import block, use upstream's order but add fork's extra imports.

6. NEVER drop a fork feature. NEVER drop an upstream feature. Both should be present in the resolved file.

7. Preserve all existing comments from both sides where they're still relevant.

# Output format

Output ONLY the fully resolved file content. No conflict markers (<<<<<<<, =======, >>>>>>>), no explanation, no markdown code fences, no commentary. Just the raw file ready to be written to disk and compiled.

If the resolved file would still need a conflict marker (e.g. because the two sides truly disagree on logic and there's no sensible merge), output the literal text:
__AI_RESOLUTION_FAILED__
followed by a one-line reason. The workflow will fall back to manual review.`

async function callClaude (filePath, content, packageName) {
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(packageName, PACKAGE_CONTEXT[packageName] ?? `Unknown package - preserve all distinctive additions on both sides.`)

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Resolve all conflict markers in this file and output the merged result:\n\n=== ${filePath} ===\n\n${content}`
    }]
  })

  const headers = {
    'content-type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  }

  let attempt = 0
  let lastErr
  while (attempt < 3) {
    attempt++
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers, body })
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || (2 ** attempt)
        console.log(`    HTTP ${res.status} - retrying in ${retryAfter}s (attempt ${attempt}/3)`)
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Claude API ${res.status}: ${text.slice(0, 500)}`)
      }
      const data = await res.json()
      const text = data.content?.[0]?.text
      if (!text) throw new Error('Empty content in response: ' + JSON.stringify(data).slice(0, 300))
      return { text, usage: data.usage }
    } catch (err) {
      lastErr = err
      if (attempt >= 3) break
      console.log(`    Attempt ${attempt} failed (${err.message}); backing off`)
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000))
    }
  }
  throw lastErr ?? new Error('All retry attempts failed')
}

async function resolveOne (filePath, packageName) {
  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.log(`  ${filePath}: cannot read (${err.message}) - skipping`)
    return { skipped: true }
  }

  if (!content.includes('<<<<<<<')) {
    console.log(`  ${filePath}: no conflict markers - skipping`)
    return { skipped: true }
  }

  console.log(`  ${filePath}: ${content.length} chars -> ${MODEL} via ${CF_AI_GATEWAY_URL ? 'CF AI Gateway' : 'direct API'}`)

  const { text, usage } = await callClaude(filePath, content, packageName)

  if (text.startsWith('__AI_RESOLUTION_FAILED__')) {
    const reason = text.split('\n')[1] ?? '(no reason given)'
    console.log(`    AI declined to resolve: ${reason}`)
    return { failed: true, reason }
  }

  if (text.includes('<<<<<<<') || text.includes('=======\n') || text.includes('>>>>>>>')) {
    console.log(`    AI output still contains conflict markers - rejecting`)
    return { failed: true, reason: 'output contained conflict markers' }
  }

  writeFileSync(filePath, text, 'utf8')
  console.log(`    resolved (${text.length} chars; tokens in=${usage?.input_tokens} out=${usage?.output_tokens})`)
  return { resolved: true, usage }
}

async function main () {
  const [packageName, ...files] = argv.slice(2)
  if (!packageName || !files.length) {
    console.error('Usage: ai-resolve-conflicts.mjs <package-name> <file1> [file2 ...]')
    exit(2)
  }

  console.log(`AI conflict resolver - package: ${packageName} - files: ${files.length}`)
  console.log(`  Endpoint: ${ENDPOINT}`)
  console.log(`  Model:    ${MODEL}`)

  let resolved = 0
  let failed = 0
  let skipped = 0
  const failures = []
  let totalIn = 0
  let totalOut = 0

  for (const f of files) {
    try {
      const r = await resolveOne(f, packageName)
      if (r.resolved) {
        resolved++
        totalIn += r.usage?.input_tokens ?? 0
        totalOut += r.usage?.output_tokens ?? 0
      } else if (r.failed) {
        failed++
        failures.push({ file: f, reason: r.reason })
      } else {
        skipped++
      }
    } catch (err) {
      failed++
      failures.push({ file: f, reason: err.message })
      console.error(`  ${f}: error - ${err.message}`)
    }
  }

  console.log(`\nSummary: ${resolved} resolved, ${failed} failed, ${skipped} skipped`)
  console.log(`Total tokens: in=${totalIn} out=${totalOut}`)

  if (failures.length) {
    console.log('\nFailures:')
    for (const { file, reason } of failures) {
      console.log(`  ${file}: ${reason}`)
    }
    exit(1)
  }
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  exit(1)
})
