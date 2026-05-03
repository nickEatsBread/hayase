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
// Four auth modes, picked in priority order (first matching env wins).
// The picked mode prints at startup so it's clear in CI logs.
//
// Override the auto-pick with AI_RESOLVE_MODE=workers-ai|cf-unified|cf-byok|direct
// when you have multiple sets of secrets configured (e.g. testing).
//
// 1. CF WORKERS AI (FREE for the first 10,000 neurons/day, ~166 reqs)
//    Cloudflare's open-weight inference: Llama, Qwen-Coder, Kimi K2.5,
//    DeepSeek etc. Hosted on CF GPUs - billed in "neurons", with a 10k/day
//    free allocation that resets at 00:00 UTC. After the daily allowance
//    runs out: $0.011 per 1000 neurons (Workers Paid plan only - Free plan
//    hard-rate-limits past 10k).
//    Setup:
//      a. Create a Cloudflare API token with Workers AI: Read permission at
//         https://dash.cloudflare.com/profile/api-tokens
//      b. Find your CF account ID at https://dash.cloudflare.com/<acct>
//         (sidebar shows "Account ID" - 32 hex chars)
//      c. Repo secrets:
//           CF_WORKERS_AI_TOKEN       the API token from (a)
//           CF_WORKERS_AI_ACCOUNT_ID  the account ID from (b)
//    Auth: Authorization: Bearer <CF_WORKERS_AI_TOKEN>
//    Endpoint: https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>
//    Default model: @cf/qwen/qwen2.5-coder-32b-instruct (code-specific,
//      better for our merge-conflict use case than general-purpose Llama).
//    Override with CF_WORKERS_AI_MODEL env (e.g. @cf/meta/llama-3.3-70b-
//      instruct-fp8-fast for general use, @cf/openchat/openchat-3.5-0106
//      for smaller/faster).
//    Bill: nothing if you stay under 10k neurons/day. A typical conflict
//      resolution is ~50-100 neurons, so practically free for our weekly
//      sync workflow.
//    Quality caveat: open-weight models follow our "preserve fork additions /
//      incorporate upstream additions" prompt less reliably than Opus.
//      Verify the AI-resolved PR carefully before merging - if you see
//      fork features dropped or upstream code missing, switch to mode 2.
//
// 2. CF UNIFIED BILLING (PAID, Cloudflare credits) - charged to your
//    Cloudflare credits, no Anthropic account/key needed. Use this when
//    Workers AI quality isn't enough.
//    Setup:
//      a. Create a Gateway at https://dash.cloudflare.com/<acct>/ai/ai-gateway
//      b. Top up credits in the Gateway's "Credits Available" card
//      c. Create a Cloudflare API token with AI Gateway: Edit permission at
//         https://dash.cloudflare.com/profile/api-tokens
//      d. Repo secrets:
//           CF_AI_GATEWAY_URL    https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic
//           CF_AI_GATEWAY_TOKEN  the API token from step (c)
//    Auth: cf-aig-authorization: Bearer <CF_AI_GATEWAY_TOKEN>
//    Bill: Cloudflare invoice + small convenience fee on top of Anthropic rates.
//
// 3. CF BYOK (PAID, Anthropic billing through CF for caching/analytics)
//    Setup:
//      a. Same as above for the gateway URL
//      b. Repo secrets:
//           CF_AI_GATEWAY_URL    same as mode 2
//           ANTHROPIC_API_KEY    sk-ant-... from console.anthropic.com
//    Auth: x-api-key: <ANTHROPIC_API_KEY>
//    Bill: Anthropic invoice as usual.
//
// 4. DIRECT TO ANTHROPIC (PAID, no Cloudflare) - simplest, no caching.
//    Setup:
//      a. Repo secret: ANTHROPIC_API_KEY only
//    Auth: x-api-key: <ANTHROPIC_API_KEY>
//    Endpoint: https://api.anthropic.com/v1/messages
//
// Optional env (all modes):
//   ANTHROPIC_MODEL       - model id for modes 2/3/4 (default: claude-opus-4-5)
//   CF_WORKERS_AI_MODEL   - model id for mode 1 (default: @cf/qwen/qwen2.5-coder-32b-instruct)
//   ANTHROPIC_MAX_TOKENS    - max output tokens for modes 2/3/4 (default: 32000)
//   CF_WORKERS_AI_MAX_TOKENS - max output tokens for mode 1 (default: 8000;
//                              don't set above the model's context window
//                              minus the input - typical models cap around
//                              32k-128k total context)
//   AI_RESOLVE_MODE         - force a specific mode (workers-ai|cf-unified|cf-byok|direct)
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
const CF_AI_GATEWAY_TOKEN = env.CF_AI_GATEWAY_TOKEN
const CF_WORKERS_AI_TOKEN = env.CF_WORKERS_AI_TOKEN
const CF_WORKERS_AI_ACCOUNT_ID = env.CF_WORKERS_AI_ACCOUNT_ID
const ANTHROPIC_MODEL = env.ANTHROPIC_MODEL ?? 'claude-opus-4-5'
// Default Workers AI model: Llama 3.3 70B FP8 fast. 128k context, fast
// inference, costs ~80 neurons per typical conflict resolution. The
// previous default Qwen2.5-Coder-32B was code-specific but capped at a
// 32k context window, which broke on any conflict file > ~30k tokens.
const CF_WORKERS_AI_MODEL = env.CF_WORKERS_AI_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
const FORCED_MODE = env.AI_RESOLVE_MODE // 'workers-ai' | 'cf-unified' | 'cf-byok' | 'direct'

// max_tokens default differs by request shape because model context
// windows differ wildly:
//   anthropic:  Opus has 200k context, can comfortably output 32k+ tokens
//   workers-ai: most CF models have 32-128k context, default to a safer
//               8k completion to leave headroom for the input
// Override with ANTHROPIC_MAX_TOKENS or CF_WORKERS_AI_MAX_TOKENS env.
function defaultMaxTokens (shape) {
  return shape === 'anthropic'
    ? Number(env.ANTHROPIC_MAX_TOKENS ?? 32000)
    : Number(env.CF_WORKERS_AI_MAX_TOKENS ?? 8000)
}

// Mode resolution. Priority order (first matching wins):
//   1. workers-ai      - free up to 10k neurons/day
//   2. cf-unified      - paid via CF credits (Cloudflare invoice)
//   3. cf-byok         - paid via Anthropic key, CF for caching
//   4. direct          - paid via Anthropic key, no CF
// AI_RESOLVE_MODE env overrides auto-pick.
let MODE
let ENDPOINT
let AUTH_HEADERS
let MODEL          // model id used in request body
let REQUEST_SHAPE  // 'anthropic' | 'workers-ai' - they have different schemas

function pickMode () {
  if (FORCED_MODE) return FORCED_MODE
  if (CF_WORKERS_AI_TOKEN && CF_WORKERS_AI_ACCOUNT_ID) return 'workers-ai'
  if (CF_AI_GATEWAY_TOKEN && CF_AI_GATEWAY_URL) return 'cf-unified'
  if (ANTHROPIC_API_KEY && CF_AI_GATEWAY_URL) return 'cf-byok'
  if (ANTHROPIC_API_KEY) return 'direct'
  return null
}

MODE = pickMode()

switch (MODE) {
  case 'workers-ai':
    if (!CF_WORKERS_AI_TOKEN || !CF_WORKERS_AI_ACCOUNT_ID) {
      console.error('ai-resolve: workers-ai mode needs both CF_WORKERS_AI_TOKEN and CF_WORKERS_AI_ACCOUNT_ID')
      exit(1)
    }
    MODEL = CF_WORKERS_AI_MODEL
    ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${CF_WORKERS_AI_ACCOUNT_ID}/ai/run/${MODEL}`
    AUTH_HEADERS = { authorization: `Bearer ${CF_WORKERS_AI_TOKEN}` }
    REQUEST_SHAPE = 'workers-ai'
    break
  case 'cf-unified':
    if (!CF_AI_GATEWAY_URL || !CF_AI_GATEWAY_TOKEN) {
      console.error('ai-resolve: cf-unified mode needs both CF_AI_GATEWAY_URL and CF_AI_GATEWAY_TOKEN')
      exit(1)
    }
    MODEL = ANTHROPIC_MODEL
    ENDPOINT = `${CF_AI_GATEWAY_URL.replace(/\/$/, '')}/v1/messages`
    AUTH_HEADERS = {
      'cf-aig-authorization': `Bearer ${CF_AI_GATEWAY_TOKEN}`,
      'anthropic-version': '2023-06-01'
    }
    REQUEST_SHAPE = 'anthropic'
    break
  case 'cf-byok':
    if (!CF_AI_GATEWAY_URL || !ANTHROPIC_API_KEY) {
      console.error('ai-resolve: cf-byok mode needs both CF_AI_GATEWAY_URL and ANTHROPIC_API_KEY')
      exit(1)
    }
    MODEL = ANTHROPIC_MODEL
    ENDPOINT = `${CF_AI_GATEWAY_URL.replace(/\/$/, '')}/v1/messages`
    AUTH_HEADERS = {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
    REQUEST_SHAPE = 'anthropic'
    break
  case 'direct':
    if (!ANTHROPIC_API_KEY) {
      console.error('ai-resolve: direct mode needs ANTHROPIC_API_KEY')
      exit(1)
    }
    MODEL = ANTHROPIC_MODEL
    ENDPOINT = 'https://api.anthropic.com/v1/messages'
    AUTH_HEADERS = {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
    REQUEST_SHAPE = 'anthropic'
    break
  default:
    console.error('ai-resolve: no auth configured. Set one of:')
    console.error('  CF_WORKERS_AI_TOKEN + CF_WORKERS_AI_ACCOUNT_ID  (FREE up to 10k neurons/day)')
    console.error('  CF_AI_GATEWAY_TOKEN + CF_AI_GATEWAY_URL          (PAID via CF credits)')
    console.error('  ANTHROPIC_API_KEY + CF_AI_GATEWAY_URL            (PAID via Anthropic, CF for caching)')
    console.error('  ANTHROPIC_API_KEY                                (PAID via Anthropic, direct)')
    exit(1)
}

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

async function callModel (filePath, content, packageName) {
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(packageName, PACKAGE_CONTEXT[packageName] ?? 'Unknown package - preserve all distinctive additions on both sides.')
  const userPrompt = `Resolve all conflict markers in this file and output the merged result:\n\n=== ${filePath} ===\n\n${content}`

  const maxTokens = defaultMaxTokens(REQUEST_SHAPE)

  let body
  if (REQUEST_SHAPE === 'anthropic') {
    body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  } else {
    // workers-ai: OpenAI-style messages with system role inline + low
    // temperature so the model is deterministic on resolutions.
    body = JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
      stream: false
    })
  }

  const headers = {
    'content-type': 'application/json',
    ...AUTH_HEADERS
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
        throw new Error(`AI API ${res.status}: ${text.slice(0, 500)}`)
      }
      const data = await res.json()

      if (REQUEST_SHAPE === 'anthropic') {
        const text = data.content?.[0]?.text
        if (!text) throw new Error('Empty content in response: ' + JSON.stringify(data).slice(0, 300))
        return { text, usage: data.usage }
      }

      // workers-ai response shape:
      //   { result: { response: "...", usage: { prompt_tokens, completion_tokens } },
      //     success: true, errors: [], messages: [] }
      // OR for some models: { result: { response: "..." }, ... } without usage,
      // OR streaming-style with `result.choices[0].message.content`.
      if (data.success === false) {
        const err = data.errors?.[0]?.message ?? JSON.stringify(data.errors).slice(0, 300)
        throw new Error(`Workers AI error: ${err}`)
      }
      const result = data.result ?? {}
      const text = result.response
        ?? result.choices?.[0]?.message?.content
        ?? result.content
      if (!text) throw new Error('Empty workers-ai response: ' + JSON.stringify(data).slice(0, 500))
      // Map workers-ai usage shape to anthropic-style for the summary log.
      const usage = result.usage
        ? { input_tokens: result.usage.prompt_tokens, output_tokens: result.usage.completion_tokens }
        : undefined
      return { text, usage }
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

  const modeLabel = MODE === 'workers-ai' ? 'CF Workers AI (FREE up to 10k neurons/day)'
    : MODE === 'cf-unified' ? 'CF AI Gateway (Unified Billing - CF credits)'
    : MODE === 'cf-byok' ? 'CF AI Gateway (BYOK - Anthropic billing)'
    : 'Anthropic API direct'
  console.log(`  ${filePath}: ${content.length} chars -> ${MODEL} via ${modeLabel}`)

  const { text, usage } = await callModel(filePath, content, packageName)

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
  console.log(`  Mode:     ${MODE}`)
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
