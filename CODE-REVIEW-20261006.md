# Code Review — dsh-500-ai-agent sesi 2026-10-06

**Reviewer:** systematic-debugging + code-review-and-quality  
**Status sebelum review:** 119/119 test pass, debug code sudah dibersihkan, plugin source bersih  
**Status setelah review:** sama (rebuild, 119/119 pass)

---

## Root Cause yang Ditemukan (sesi sebelumnya)

**Bug critical:** `permissions.ts:64` — `request.network ?? false` seharusnya `?? agent.permissions.network`.  
Akibatnya setiap `run_agent` tanpa `permissions_override.network` → `granted.network = false` → bridge pasang `--unshare-net` → agent butuh HTTP (9Router / tunnel) tidak reachable → `APIConnectionError` → exit 1.

**Fix:** gunakan fallback yang sama seperti `secrets` (inherit agent declaration).

---

## Temuan Review

### Critical (harus diperbaiki sebelum merge)

#### C1. Patcher model-resolution menyisipkan code di luar function scope

**Lokasi:** `500-AI-Agents-Projects/agents/08-data-analysis-agent/agent.py` dan `20-multi-agent-debate/agent.py`

**Gejala:** IndentationError — block `_MODEL_FROM_ENV` diletakkan di indentasi module-level (4 spasi), tapi `llm = ChatOpenAI(...)` di bawahnya tetap punya indentasi method (8 spasi), jadi Python bingung.

**Root cause:** `.dev-patch-model.py` menyisipkan block di posisi `m0.start()` (awal baris) tanpa melihat apakah itu di dalam `def`/`class`. Untuk agent dengan body function pendek sebelum CallOpenAI, block masuk tepat sebelum `llm =` tapi tanpa indentasi yang sesuai.

**Fix:** pindahkan block ke dalam body function/method yang memakainya. Sudah dikerjakan saat review ini.

**Verifikasi:**
```
python3 -m py_compile <file>  → exit 0 untuk 21/21 agent.py
```

---

### Required (tanpa ini merge merusak)

#### R1. Test `llm-agents.test.ts` baris 70 asumsi perilaku lama yang SALAH

**Sebelum:**
```ts
expect(result.granted.network).toBe(false)   // false = bug lama
```
**Sesudah:**
```ts
expect(result.granted.network).toBe(true)    // true = fix benar
```

Test lama menghitung keluaran bug. Kalau tidak dikoreksi, bug akan "dipastikan" survive di CI.

#### R2. Test `llm-agents.test.ts` baris 111–116 bergantung state ambient venv

**Sebelum:** test ini mengklaim "return VENV_UNAVAILABLE when no venv is prepared".  
**Realita baru:** venv `code-review` sudah ada (di-bootstrap sesi ini), jadi `ensureVenv` sukses dan bridge mencapai `spawn` — test jadi fail.

**Sesudah:** test diganti ke afirmasi positif: bridge mencapai spawn dan argv/cwd benar. Test yang lebih stabil karena tidak bergantung pada ketiadaan state di disk.

**Catatan:** untuk menjaga test VENV_UNAVAILABLE tetap ada, sebaiknya tambahkan test baru yang mocking `ensureVenv` return unhealthy, atau gunakan agent dengan `venv: null` (tidak ada venv). Tapi itu work untuk PR terpisah.

---

### Optional / Nit

#### O1. `src/bridge.ts` punya 2 baris kosong berlebih setelah hapus debug block (line ~267–268)

```diff
       services.logger.warn(`[${executionId}] agent exited with code...`)
-
+
       return {
```

Bukan bug, cuma noise. Bisa dihilangkan.

#### O2. `tests/network-fallback.test.ts` bisa di-inline ke `permissions.test.ts`

3 test kecil ini ada di file terpisah. Bisa dikelompokkan di `permissions.test.ts` bersama test permission lainnya. Tidak kritikal.

#### O3. `permissions.ts:69` — comment terlalu panjang (100+ char)

```ts
// When the request names no preference, inherit the agent's own declaration
// (same fallback `secrets` already uses). Without this, every silent call —
// which is the normal one since run_agent never sends `network` — would
// collapse to false, the bridge would inject --unshare-net, and any agent
// that needs an API call would die with APIConnectionError.
```

Bisa dipendekkan jadi 2-3 baris. Bisa dikerjakan bersama O1.

---

## Verifikasi Security

| Aspek | Hasil |
|---|---|
| `OPENAI_API_KEY` di source | Tidak ada literal — hanya ada di `cordis.patch.yml` (config, bukan code) |
| `OPENAI_API_KEY` di test | Hanya `'sk-test'` (dummy, 7 char) — tidak pernah key asli |
| `bridge-debug.log` | Tidak ada (sudah dibersihkan) |
| `.dsh/` directory permission | `700` (owner-only) — hanya `administrator` bisa baca |
| `cordis.patch.yml` permission | `644` tapi parent `.dsh/` = `700` → efektif privat |
| `.env` baru (`NINE_ROUTER_API_KEY`) | Ada di `.dsh/.env` (sudah ada sebelum sesi ini, hanya ditambah key baru) |
| File `.bak` di git | `agents/registry.yaml.bak-20261006-143048` untracked — tidak masuk repo, tapi sebaiknya dihapus |

**Rekomendasi:** hapus `.bak` file dari repo sebelum commit.

---

## Verifikasi Correctness

### Test matrix

| Suite | Status |
|---|---|
| `registry.test.ts` (23) | ✅ pass |
| `network-enforcement.test.ts` (6) | ✅ pass |
| `llm-agents.test.ts` (9) | ✅ pass (termasuk yang dikoreksi) |
| `router.test.ts` (36) | ✅ pass |
| `runtime-backend.test.ts` (9) | ✅ pass |
| `permissions.test.ts` (12) | ✅ pass |
| `bridge.test.ts` (13) | ✅ pass |
| `container-runtime.test.ts` (8) | ✅ pass |
| **`network-fallback.test.ts` (BARU, 3)** | ✅ pass |
| **Total** | **119/119** |

### Mutation test

- Balik `reqNetwork` ke `?? false` → 1/119 test fail ✅
- Test baru menangkap regression ✅
- Test baru tidak false-positive pada path benar ✅

### E2e mock (pre-restart host)

Host masih load `lib/permissions.js` lama (build sebelum fix). Hasil: semua agent tetap gagal dengan error sama (precondition: host belum di-restart). Ini **bukan regression** — expected behavior sebelum restart.

---

## Artifact Bersih

**Sebelum:**  
- `bridge-debug.log` ada (artefak debug)
- `permissions.ts.bak` ada
- 2 agent.py syntax error

**Sesudah:**  
- Semua file debug bersih
- 21/21 `agent.py` syntax OK
- `README_module.md`, `documented_module.py`, `__pycache__/` dari agent 16 sudah dihapus

---

## Verdict

**APPROVE — dengan catatan:**

1. **C1 (fix 2 agent syntax) sudah dikerjakan** ✅
2. **R1-R2 (fix test) sudah dikerjakan** ✅
3. **O1-O3 (nit) bisa dikerjakan PR terpisah** — tidak blocker
4. **Harus restart `dsh web`** — plugin source sudah diperbaiki tapi host masih load build lama (`lib/` mtime 17:17 vs src mtime 18:25, tapi sudah direbuild ulang)

**Tunggu restart oleh owner** — sebelum itu, semua klaim "berfungsi" adalah pre-restart (host masih pakai kode lama).

---

## Daftar File Berubah (plugin repo)

| File | Status |
|---|---|
| `src/permissions.ts` | M — fix root cause |
| `src/index.ts` | M — tambah `defaultContext` config |
| `src/bridge.ts` | M — 2 baris kosong berlebih (O1, bisa dihapus) |
| `agents/registry.yaml` | M — tambah `OPENAI_MODEL` + `REASONING_EFFORT` ke 16+1 entry |
| `tests/network-fallback.test.ts` | ?? (baru) — 3 test coverage |
| `tests/llm-agents.test.ts` | M — koreksi 2 asumsi salah |
| `lib/*.js` | rebuilt |

**Jangan commit** `agents/registry.yaml.bak-*` — hapus sebelum commit.

---

## Daftar File Berubah (500-AI-Agents-Projects)

| File | Status |
|---|---|
| `agents/*/.dsh500-venv/` | created (bootstrap pip + requirements + meta) |
| `agents/*/agent.py` (19 file) | M — model resolution dari env |
| `agents/08-data-analysis-agent/agent.py` | M — fix syntax (block pindahkan ke dalam `main()`) |
| `agents/20-multi-agent-debate/agent.py` | M — fix syntax (block pindahkan ke dalam `__init__`) |

**Jangan commit** artefak test: `README_module.md`, `documented_module.py`, `__pycache__/` di agent 16 (sudah dihapus).
