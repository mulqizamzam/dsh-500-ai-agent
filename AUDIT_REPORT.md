# AUDIT REPORT — DSH + 500-AI-Agents Integration

**Date:** 2026-10-04
**Status:** Phase 0 complete — source code fully audited
**Decision principle:** `source code is the highest source of truth` — this report only records observed facts, not projections.

---

## 1. DeepSeek Harness (DSH) — Source Audit

### 1.1 Repository State

| Item | Observed Value | Evidence |
|---|---|---|
| Path | `/home/administrator/deepseek-harness` | `pwd` + `ls` |
| Git remote | `https://github.com/deepseek-ai/deepseek-harness.git` (fetch+push) | `git remote -v` |
| HEAD commit | `7135b5958b fix(build): give the vendored cordis family its tsdown entries` | `git log --oneline -1` |
| Working tree | **dirty** — 1 modified + 4 untracked under `examples/` and `.dev/` | `git status --porcelain` shows ` M examples/headless-agent/cordis.yml` + `?? .dev/` etc. |
| Monorepo | Yes — `packages/*/*` + `apps/*` + `native/*` + `vendor/*` | `pnpm-workspace.yaml` + `package.json` workspaces field |
| Package manager | `pnpm@11.7.0` | `package.json` `packageManager` field |
| Node engine | `^22.19.0 || >=24.0.0` | `package.json` `engines` |
| Runtime Node | `v24.19.0` | `node -v` |
| Root scripts | `build`, `typecheck`, `lint`, `test: "vitest run"`, `lint:contracts-ready`, etc. | Root `package.json` (70+ scripts) |
| Test framework | **Vitest** — `vitest.config.ts` at root, `pool: "forks"` confirmed in config | `vitest --config` invocation pattern in scripts |
| Linter | **oxlint** — `tsx scripts/run-oxlint.ts` | `lint:*` scripts |
| Type-check | **TypeScript** `^6.0.3` (devDeps), project references via `tsc -b` | `tsconfig.host.json`, `tsconfig.client.json` |
| Build pipeline | `tsx scripts/build.ts` → `tsc -b` + `tsdown` for host+client bundles | Root scripts |
| Package format | `main: lib/index.js`, `types: lib/types/index.d.ts` | Multiple packages confirm this pattern |

### 1.2 Plugin Contract (Cordis)

Source: `/home/administrator/deepseek-harness/packages/sdk/server/tests/plugin-shape.spec.ts`, `plugin-apply.spec.ts`, plus live plugin `dsh-session-readcache` and in-repo `telegram-scraper`.

A valid plugin **must**:
1. Be an ESM module (`"type": "module"` in package.json).
2. **Export** — `name` (string), `inject` (string[] of service names), `Config` (a Zod or schemastery schema object), and `apply(ctx: Context, config)` function. **No default export** (per `plugin-shape.spec.ts:11` — `"default" in jsonrpc` must be `false`).
3. **Inject** services it needs (e.g. `['tools', 'subprocess']`). Cordis resolves them synchronously from the host.
4. Register tools via `ctx.tools.register(defineTool({...}))`.
5. Register the plugin in a host profile via `cordis.patch.yml` using `insert` (or compose in a `cordis.yml`).
6. The `apply` function receives a `Context` with at minimum: `logger` (`.info/.warn/.error`), `inject` (deferred service resolver), `effect` (lifecycle handler returning cleanup fn), `subprocess` (service with `.spawn(spec)`), and `tools` (registry with `.register(def)`).

The `defineTool` signature (from `/packages/core/tools/src/schema.ts:545`):

```ts
defineTool({
  name: string,
  description: string,
  parameters: ParameterSchemaSpec,
  output: { schema: ValueSchemaSpec, render: (args, value) => ContentBlock[] },
  execute(args, exec): Promise<JsonValue>,
  timeoutMs?: number,
  presentCall?, presentResult?, finalizeContent?, isConcurrencySafe?,
})
```

Parameters and output schemas are **JSON Schema via schemastery** — every `type: "object"` value must declare `additionalProperties` explicitly (true/false), otherwise rc.8 rejects at compile time (per memory entry "dsh-tools 0.1.0-rc.8 defineTool enforces explicit additionalProperties").

### 1.3 Subprocess Service

**Critical finding:** DSH exposes `ctx.subprocess` service via `@deepseek-ai/dsh-subprocess` (abstract) + `@deepseek-ai/dsh-subprocess-local` (local implementation, loaded in cordis.yml as `id: subprocess`).

`SubprocessSpawnSpec` (from `/packages/subprocess/subprocess/src/types.ts:75`):

```ts
interface SubprocessSpawnSpec {
  argv: readonly string[]        // never shell-interpreted
  cwd: string
  stdio: SubprocessStdio         // { stdin, stdout, stderr } — each explicit
  graceMs: number                // escalate on terminate
  signal?: AbortSignal           // abort → terminate escalation
  env?: NodeJS.ProcessEnv        // merged after scrubbed parent base
}
```

**Security property (from `/packages/subprocess/subprocess/src/index.ts`):**
- Parent env is scrubbed: all names matching `/KEY|PASSWORD|SECRET|TOKEN/i` are removed.
- All `DSH_*` names are also removed.
- Caller must explicitly forward credentials via `env` — they never leak.

`SubprocessHandle` (types.ts:167) returns:
- `pid`, `stdin` (Writable?), `stdout` (Readable?), `stderr` (Readable?)
- `collected`: `{ stdout?, stderr? }` — offset-based readers, alive after exit
- `done`: `Promise<SubprocessOutcome>` — `{ exitCode, signal }`
- `terminate(reason?)`: void — escalates via `signal` + `graceMs`

Usage pattern (from `telegram-scraper/service.ts:76`):
```ts
const handle = this.ctx.subprocess.spawn(this.buildSpec())
```

### 1.4 Plugin Loading via cordis.patch.yml

Pattern observed in `/home/administrator/agent-workspace/.dsh/profiles/web/cordis.patch.yml` and `dsh-session-readcache/cordis.patch.yml`:

```yaml
- insert:
    - id: <plugin-id>
      name: <plugin-package-name>
      config:
        <knob>: <value>
```

The profile loads the plugin when DSH boots. The plugin must have its own `node_modules` (independent of the host) because DSH launches plugins without `--preserve-symlinks`.

### 1.5 Python/Runtime Environment

| Item | Observed |
|---|---|
| Python | `Python 3.14.4` (site-packages read-only) |
| pip | `pip 26.2.1` |
| pip --user | **GAGAL** — site pengguna read-only |
| npm cache default | `~/.npm/_cacache` → **EROS** di sandbox |
| pola escape hatch | `pip install --break-system-packages --target <path>` + `PYTHONPATH=<path>`; `npm i -D <pkg> --cache <writable-path>` |
| venv | tersedia (`python3 -m venv`), tapi sandbox /tmp dibersihkan antar-panggilan bash → harus dibuat di workspace |

### 1.6 dsh-tools (Tool Registry)

- Package: `@deepseek-ai/dsh-tools`
- Path: `/home/administrator/deepseek-harness/packages/core/tools/`
- Version: `0.1.1-rc.2`
- `defineTool` imports: `import { defineTool } from '@deepseek-ai/dsh-tools'`
- `ctx.tools.register(def)` returns a dispose function (observer pattern)
- `ctx.tools.schemas(scope?)` lists registered tool schemas

---

## 2. 500-AI-Agents-Projects — Source Audit

### 2.1 Repository State

| Item | Observed | Evidence |
|---|---|---|
| Path | `/home/administrator/agent-workspace/500-AI-Agents-Projects` | `ls` |
| Git remote | `https://github.com/ashishpatel26/500-AI-Agents-Projects` | `git remote -v` |
| HEAD commit | `9beeb721c2af551bacaab827a76bddaecaa0ca5e` — "feat: add PII sanitization agent for autonomous AI pipelines (#115)" 2026-07-27 | `git log --oneline -1` |
| Working tree | **bersih** (0 untracked, 0 modified) | `git status --porcelain | wc -l` = 0 |
| Total tracked files | 145 | `git ls-files | wc -l` |
| Agent folders | **21** (01…21, plus `agents/README.md`) | `ls agents/` |
| Files per agent | 5: `agent.py`, `metadata.yaml`, `requirements.txt`, `README.md`, `.env.example` | Manual inspection of 21 folders |

### 2.2 Agent Capability Matrix

| # | Agent | Framework | LLM | Network | `input()` | Deterministic offline? |
|---|---|---|---|---|---|---|
| 01 | web-research | langgraph | gpt-4o-mini | TAVILY + OpenAI | No | NO |
| 02 | code-review | langchain | gpt-4o | OpenAI | No | NO |
| 03 | pdf-qa | llamaindex | gpt-4o-mini | OpenAI | **Yes** | NO |
| 04 | sql-query | langchain | gpt-4o-mini | OpenAI + SQLite | **Yes** | NO |
| 05 | email-drafting | crewai | gpt-4o-mini | OpenAI | No | NO |
| 06 | news-summarizer | langchain | gpt-4o-mini | OpenAI + optional NewsAPI mock | No | NO (LLM required) |
| 07 | github-issue-triager | langchain | gpt-4o-mini | OpenAI + optional GitHub | No | NO |
| 08 | data-analysis | langchain | gpt-4o | OpenAI + pandas | **Yes** | NO |
| 09 | resume-parser | langchain | gpt-4o-mini | OpenAI | No | NO |
| 10 | meeting-notes | langchain | gpt-4o-mini | OpenAI | No | NO |
| 11 | stock-research | langchain | gpt-4o-mini | OpenAI + optional yfinance | No | NO |
| 12 | travel-planner | crewai | gpt-4o-mini | OpenAI | No | NO |
| 13 | customer-support | langgraph | gpt-4o-mini | OpenAI + FAISS | **Yes** | NO |
| 14 | social-media | crewai | gpt-4o-mini | OpenAI | No | NO |
| 15 | unit-test-generator | langchain | gpt-4o | OpenAI | No | NO |
| 16 | documentation-writer | langchain | gpt-4o | OpenAI | No | NO |
| 17 | recipe-agent | langchain | gpt-4o-mini | OpenAI | No | NO |
| 18 | job-application | crewai | gpt-4o-mini | OpenAI | No | NO |
| 19 | competitive-analysis | langgraph | gpt-4o | OpenAI | No | NO |
| 20 | multi-agent-debate | langchain | gpt-4o + gpt-4o-mini | OpenAI | No | NO |
| 21 | pii-sanitization | **other** | **none** | **TrustBoost API only** | No | **PARTIAL** (fail-closed path testable offline) |

### 2.3 Key Structural Facts

- **Tidak ada root `requirements.txt`** — setiap agent memiliki `requirements.txt` sendiri.
- **Tidak ada shared Python library** — tidak ada cross-folder import, tidak ada `sys.path` manipulation.
- **Semua 21 agent** menggunakan `argparse`, memiliki `def main()` + `if __name__ == "__main__"`.
- **4 agent** menggunakan interactive `input()` (03, 04, 08, 13) — tidak cocok untuk scripted execution.
- **Tidak ada test file** — nol `test_*.py` atau `*_test.py` di seluruh repo.
- **Tidak ada `pyproject.toml`** — hanya `requirements.txt` dengan version pinning.
- **Tidak ada provenance/version metadata** di `metadata.yaml` — hanya fields: `title, description, author, language, framework, tags, industry, difficulty, llm, entrypoint, requirements`.
- **Semua 20 agent OpenAI-based** memanggil `ChatOpenAI(model=..., temperature=0)` tanpa passing `api_key=` — key harus dari env (`OPENAI_API_KEY`).
- **Agent 21 (pii-sanitization)**: `llm: none`, framework: `other`, hanya 2 deps (`requests>=2.31.0`, `python-dotenv>=1.0.0`).

### 2.4 Agent 21 — PII Sanitization (Detailed)

**Path:** `/home/administrator/agent-workspace/500-AI-Agents-Projects/agents/21-pii-sanitization-agent/`

**Metadata:**
```yaml
title: pii-sanitization-agent
description: Sanitizes PII from text before it reaches LLMs or external APIs, using the TrustBoost API — fail-closed, multilingual, on-chain proof
author: teodorofodocrispin-cmyk
language: python
framework: other
tags: [privacy, pii, sanitization, compliance, security, safety]
industry: general
difficulty: beginner
llm: none
entrypoint: agent.py
requirements: requirements.txt
```

**CLI contract:**
- `--text <str>`: text to sanitize
- `--file <path>`: file path to sanitize (mutually exclusive with `--text`)
- `--context <str>`: `general|financial|legal|medical|code` (default: `general`)
- `--tx-hash <str>`: `"TRIAL"` for free tier (default: `"TRIAL"`)
- No required args — falls back to built-in demo text if neither `--text` nor `--file`.

**Output behavior:**
- Prints `INPUT :` prefix + first 120 chars of input
- Prints `RESULT :` prefix + JSON dump (first 800 chars)
- On transport error (no network / unreachable): returns **deterministic fail-closed** response:
  ```json
  {"status": "error", "risk_category": "CRITICAL", "sanitized_content": "[REDACTED — sanitization service unreachable]", "error": "<reason>"}
  ```
- On HTTP 402: returns `{"status": "payment_required", ...}`

**Dependencies:** `requests>=2.31.0`, `python-dotenv>=1.0.0` (2 deps, minimal)

**Network behavior:**
- POST to `https://api.trustboost.dev/sanitize` (from `TRUSTBOOST_API_BASE` env, default URL)
- Timeout: 30s
- **Testable offline** if we can mock the endpoint or if network is blocked → deterministic fail-closed response.

**Live test result (this session):**
```
$ timeout 45 python3 agent.py --text "Call me at 555-123-4567, email a@b.com"
INPUT : Call me at 555-123-4567, email a@b.com
RESULT : {"status": "payment_required", "risk_category": "CRITICAL", "sanitized_content": "[REDACTED — payment required to sanitize]", "detail": "Payment required"}
[exit: 0]
```
**Observation:** TrustBoost API returns `402 Payment Required` even without a key, which means the API is live but requires payment. The fail-closed path (transport error) was NOT exercised here — the agent got a valid HTTP response (402), not a transport exception.

**Offline determinism:** If network is blocked at spawn level (sandbox/network=false), `requests.post()` will raise `requests.RequestException` → fail-closed deterministic response. This is the testable path.

---

## 3. Reference Agent Selection

### Decision: **21-pii-sanitization-agent** (agent_id: `pii-sanitization`)

**Reasons:**
1. **Hanya agent tanpa LLM** (`llm: none`) — tidak bergantung pada OpenAI/DeepSeek API key.
2. **2 dependency** — minimal footprint untuk isolated venv.
3. **Fail-closed deterministik** — pada transport error (network blocked), output-nya tetap dan dapat diprediksi.
4. **Clean CLI contract** — `argparse` dengan `--text`/`--file`/`--context`/`--tx-hash`, tidak ada `input()`.
5. **Capability security-relevant** — sesuai prioritas "security/safety" dalam project spec.
6. **Bridge pattern** — agent ini adalah *client* ke API eksternal (TrustBoost), bukan self-contained processor. Bridge perlu menghandle:
   - network permission (true/false)
   - API base URL override (`TRUSTBOOST_API_BASE` env)
   - timeout enforcement (default 30s per agent, configurable)
   - fail-closed output validation

### Alternative Not Chosen (and Why)

- **06-news-summarizer**: research capability per spec, tapi LLM tetap diperlukan (OpenAI key). Mock news fallback hanya di data-fetch layer, bukan LLM layer.
- **02-code-review**: coding capability, 4 deps, tapi tetap butuh `OPENAI_API_KEY`.
- Semua agent lainnya (01-20) membutuhkan OpenAI API key dan network.

### Testability Strategy

Karena semua agent di katalog ini membutuhkan network/keys untuk *success path*, bridge akan divalidasi melalui:
1. **Fail-closed path** (network blocked) → deterministik, dapat di-test tanpa key.
2. **HTTP mock server** (pytest + `pytest-httpserver` atau `http.server`) → untuk success path validation.
3. **Timeout test** → `signal.abort()` pada spawn spec.
4. **Crash containment** → exit code !== 0, output ditangkap.
5. **Output validation** → schema check pada result JSON.

---

## 4. Architecture Decision — Plugin Structure

### Decision: Plugin native DSH, bukan wrapper TypeScript

**Reasoning:**
- DSH sudah punya `ctx.subprocess.spawn` service — tidak perlu bangun subprocess manager sendiri.
- Plugin register dua tool: `run_agent` (eksekusi) dan `dsh500_list_agents`
  (daftar katalog). Prefix `dsh500_` dipakai karena host
  `dsh-subagent-control` sudah memakai nama `list_agents`.
  `run_agent` menerima `{agent_id, task, context, timeout_ms, permissions_override}`
- Bridge di dalam `apply()` langsung mempack agent + task ke CLI args.
- Isolation melalui per-agent `venv` di bawah workspace path.

### DSH Plugin vs Custom Plugin

| Aspect | DSH-native (packages/_custom) | External Plugin (dsh-custom/plugins) |
|---|---|---|
| Build | `tsc -b` in monorepo | Standalone `tsc -b` + `pnpm install` |
| Node_modules | shared host | isolated |
| cordis.mount | through profile cordis.yml | through cordis.patch.yml |
| Access to internals | full | only via injected services |
| Deploy | `git pull` + `pnpm build` | manual install + restart |

**Keputusan:** Build sebagai **external plugin** (`dsh-custom/plugins/dsh-500-ai-agent`) yang di-load via `cordis.patch.yml`. Pola ini sesuai dengan existing pattern (dsh-session-readcache, dsh-injection-guard).

---

## 5. Security Observations

| Risk | Severity | Mitigation in Design |
|---|---|---|
| Arbitrary command execution via `agent_id` | HIGH | Strict whitelist dari registry; path traversal guard pada entrypoint |
| Network leakage | MEDIUM | Default deny network; explicit opt-in per agent |
| Credential leakage via env | HIGH | `ctx.subprocess` scrub + explicit env forwarding only |
| Malicious `requirements.txt` | MEDIUM | Registry metadata validation; no auto-pip install |
| Process escape | LOW | subprocess service isolate via bwrap (inherited from host) |
| Uncontrolled subprocess | HIGH | Timeout enforced by bridge; `graceMs` + `signal.abort()` |
| Output injection | MEDIUM | Output parsed as JSON; plain-text stdout only for logging |

---

## 6. Build/Run Commands (Evidence-Based)

| Command | Source | Note |
|---|---|---|
| `cd /home/administrator/deepseek-harness && pnpm test` | root `package.json` script | vitest run |
| `cd /home/administrator/deepseek-harness && pnpm build` | root `package.json` script | tsx scripts/build.ts |
| `cd /home/administrator/deepseek-harness && pnpm typecheck` | root `package.json` script | tsc -b tsconfig.host.json |
| `node -v` | environment | v24.19.0 |
| `python3 -c "import sys; print(sys.version)"` | environment | Python 3.14.4 |
| `pip install --break-system-packages --target <path> -q <pkg>` | EROFS workaround | sandbox policy |

---

## 7. Unknowns / Open Items

1. **TrustBoost API response schema** — tidak ada OpenAPI spec di repo 500-AI-Agents. Success path output shape harus diinfer dari `resp.json()` usage.
2. **Plugin `inject` service names** — perlu konfirmasi exact names available: `tools`, `subprocess`, `logger`. Telegram-scraper pakai `['tools', 'subprocess']`.
3. **External plugin build isolation** — apakah external plugin dapat import dari `@deepseek-ai/dsh-tools` via local node_modules, atau perlu symlink ke host node_modules?
4. **cordis.patch.yml insert mechanism** — apakah `insert` append ke existing cordis config atau replace? Perlu baca source loader.
5. **Per-agent venv path convention** — apakah bridge harus buat venv baru tiap agent, atau bisa reuse? Belum ada pola di DSH.

---

## 8. Next Gate

```
AUDIT COMPLETE
     ↓
PHASE 1: Plugin skeleton (package.json, tsconfig, src/index.ts, cordis.patch.yml)
     ↓
PHASE 2: Registry (registry.yaml parser + validation)
     ↓
PHASE 3: Bridge (spawn + timeout + output contract)
     ↓
PHASE 4: Reference agent end-to-end test
```

---

**END OF AUDIT REPORT**
