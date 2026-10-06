# Phase 3 Close — DSH 500+ AI Agents Plugin

## What was completed

| Gate | Status | Evidence |
|---|---|---|
| Plugin source (9 files) | ✅ | `src/` + `lib/` built, tsc exit 0 |
| Registry parser | ✅ | 23 tests, YAML load + validation |
| Capability router | ✅ | 36 tests, keyword detection + filter |
| Permission evaluator (default-deny) | ✅ | 12 tests, deny-unknown + subset-check |
| Runtime manager (venv fallback) | ✅ | 9 tests, EROFS→fallback path |
| ContainerRuntime stub | ✅ | `src/container-runtime.ts` |
| Bridge (spawn + confine + timeout) | ✅ | 13 tests, JSON validate |
| Network denial proof | ✅ | 6 tests, socket.connect BLOCKED |
| LLM agent E2E tests | ✅ | 9 tests (fixture-stub success + missing-key error paths) |
| PII reference agent E2E | ✅ | 2 tests (fail-closed unreachable + local-fixture success) |
| Plugin loaded in web profile | ✅ | VERIFIED 2026-10-06: `dsh500_list_agents` terdaftar di host tool set, mengembalikan 17 agent |
| Config schema validation | ✅ | `Config['~standard'].validate` function present |
| 118 regression tests | ✅ | 116 unit (8 files) + 2 e2e, 31s total |

## What is BLOCKED — operator action required

### Install into web profile

Path `$DSH_HOME/profiles/web/` is on the read-only root mount (EROFS).
Three edits are needed (package.json + cordis.patch.yml), then `pnpm install`.
See `INSTALL-WEB.md` for exact diffs. **Sudah dijalankan** (VERIFIED 2026-10-06:
plugin ter-mount, `dsh500_list_agents` mengembalikan 17 agent di host tool set).

### Live tool invocation from CLI

Web profile surface is browser-first; playwright-core commander rejects
positional task args:
```
error: too many arguments. Expected 0 arguments but got 1: <task text>
```
Use the DSH web UI console for `run_agent` / `dsh500_list_agents` calls,
or use the headless profile for one-shot CLI runs.

### Credential-based LLM E2E

No `OPENAI_API_KEY` / `TAVILY_API_KEY` in environment — verified.
Tests assert the error path (AGENT_MISSING_CREDENTIAL). Full agent runs
pending credential.

## What is KNOWN UNTESTED

| Item | Reason |
|---|---|
| Venv pip install of full 3 LLM deps | Network/build time > run window |
| ContainerRuntime wired into bridge | Stub only; selector not changed |
| `shell: false` enforcement | bubblewrap cannot deny os.system(); see P6 section |

## Known design limits

1. bubblewrap network denial is kernel-level (`--unshare-net`), verified.
2. bubblewrap filesystem denial works for the subprocess; Python
   `os.system()` / `subprocess.call()` inside the child bypasses it.
3. Container runtime would fix both, but is a stub in Phase 3.
4. E2B not required (per requirement spec).
5. Plugin config MUST use `Schema.object({...})` — plain object crashes
   Cordis `resolveConfig()` with `Cannot read properties of undefined`.
6. Tool name must avoid host collision — uses `dsh500_` prefix.

## Artifacts produced this session

- `src/index.ts` — plugin entry
- `src/types.ts` — data types
- `src/registry.ts` — YAML parser
- `src/router.ts` — capability routing
- `src/permissions.ts` — default-deny evaluator
- `src/runtime-manager.ts` — venv + writability probe
- `src/runtime-backend.ts` — bubblewrap backend builder
- `src/container-runtime.ts` — stub
- `src/bridge.ts` — spawn + confine + timeout + validate
- `tests/*.test.ts` — 118 tests (116 unit + 2 e2e)
- `BUILD_REPORT.md` — Phase 3 build report (corrected counts)
- `ASSUMPTIONS.md` — Phase 3 new assumptions appended
- `README.md` — updated with runtime/security sections
- `INSTALL-WEB.md` — operator install instructions
- `PHASE3-CLOSE.md` — this file
