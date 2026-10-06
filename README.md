# dsh-500-ai-agent

Capability bridge yang mengekspos agent dari
[ashishpatel26/500-AI-Agents-Projects](https://github.com/ashishpatel26/500-AI-Agents-Projects)
sebagai tool DeepSeek Harness yang dikendalikan registry, digerbang permission,
dan berjalan di runtime terisolasi.

Status: **source lengkap, build clean, 116 unit test + 2 e2e test lulus, plugin ter-mount di profil web** (VERIFIED 2026-10-06: `dsh500_list_agents` dan `run_agent` terdaftar di tool host, registry berisi 17 agent). Detail di `BUILD_REPORT.md`.

## Arsitektur

```text
User
  |
  v
DeepSeek Harness
  |
  +-- Agent Loop / LLM / Tools / Session / Policy
         |
         v
  dsh-500-ai-agent plugin
         |
         +-- Capability Router      deteksi kapabilitas dari task
         +-- Agent Registry         baca + validasi agents/registry.yaml
         +-- Permission Manager     default deny, grant eksplisit
         +-- Agent Bridge           spawn via ctx.subprocess
         |
         v
  Isolated Agent Runtime
         |
         +-- Python Agent (per-agent venv / process tree)
         +-- ContainerRuntime (stub, Phase 9+)
```

Registri adalah sumber kebenaran tunggal. Bridge tidak memindai filesystem
untuk mencari `agent.py`; hanya entri yang terdaftar di `agents/registry.yaml`
yang bisa dipanggil.

## Instalasi

```bash
cd dsh-custom/plugins/dsh-500-ai-agent
npm install
npm run build
```

Aktifkan di profil DSH dengan menambahkan ke
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: 500-ai-agent
      name: dsh-500-ai-agent
      config:
        registryPath: <path>/agents/registry.yaml
        workspaceRoot: <path>
        enableRouting: true
        logLevel: info
```

Restart `dsh web` setelah config berubah (restart adalah aksi operator).

## Konfigurasi

| Knob | Default | Arti |
|---|---|---|
| `registryPath` | `agents/registry.yaml` | Lokasi registry, relatif ke `workspaceRoot` |
| `workspaceRoot` | `''` (cwd) | Basis untuk path relatif agent |
| `enableRouting` | `true` | Auto-pilih agent dari task bila `agent_id` absen |
| `logLevel` | `info` | `info` / `warn` / `error` |

## Registry

Satu entri per agent. Semua field wajib kecuali `venv`, `maturity`,
`entrypoint_args`.

```yaml
pii-sanitization:
  agent_id: pii-sanitization        # /^[a-z][a-z0-9-]{0,63}$/
  name: PII Sanitization Agent
  version: 1.0.0                    # versi entri katalog, bukan versi agent
  runtime:
    type: python
    version: "3.11"
  entrypoint: agent.py
  entrypoint_args:                  # template argv, bukan string shell
    - "--text"
    - "{{task}}"
    - "--tx-hash"
    - "TRIAL"
  capabilities: [pii, security]
  permissions:                      # default deny
    network: true
    filesystem: null
    shell: false
    secrets: []
  resources:
    timeout_ms: 120000
  source:                           # provenance
    repository: ashishpatel26/500-AI-Agents-Projects
    path: agents/21-pii-sanitization-agent
    commit: 9beeb721c2af551bacaab827a76bddaecaa0ca5e
  status: experimental              # registered|experimental|validated|production|disabled
  root: ../../../../500-AI-Agents-Projects/agents/21-pii-sanitization-agent
  venv: .venv                       # opsional
```

`root` relatif terhadap direktori file registry, bukan CWD. Registry
menormalkan `root` ke path absolut saat parse.

`entrypoint_args` adalah argv posisional: tiap elemen literal atau
placeholder `{{task}}` / `{{timeout_ms}}` / `{{nama_context}}`. Nilai yang
diresolusi diteruskan ke execve apa adanya, tanpa quoting shell.

## Menambahkan agent

1. Tambah entri di `agents/registry.yaml`.
2. Isi `capabilities` dengan tag yang valid: `research`, `code-review`,
   `pii`, `summary`, `documentation`, `security`, `compliance`, `qa`,
   `data-analysis`, `general`.
3. Isi `source` dengan repository, path, dan commit.
4. Set `status: registered`. Agent berstatus `registered` atau `disabled`
   ditolak saat dipanggil.
5. Naikkan ke `experimental` setelah invocation pertama berhasil, lalu
   `validated` setelah seluruh test lulus.

Capability tag baru perlu ditambah di `src/types.ts` (`AgentCapability`)
dan `src/registry.ts` (`VALID_CAPABILITIES`) lebih dulu.

## Isolasi runtime

Setiap agent berjalan sebagai proses terpisah di bawah `cwd` miliknya sendiri.
Bridge memakai `ctx.subprocess.spawn` dari DSH, yang sudah:

- membenamkan environment: nama yang cocok `KEY|PASSWORD|SECRET|TOKEN` dan
  semua `DSH_*` dibuang dari parent env, kecuali yang diteruskan eksplisit
  lewat `spec.env`
- melakukan terminate tree-scoped: POSIX menyinyal process group,
  Windows memakai `taskkill /T`
- Kill escalation: `spec.signal` memicu terminasi, `graceMs` mengatur
  jeda eskalasi

Isolasi per-agent via venv: set `venv: .venv` lalu buat venv di dalam folder
agent. Bridge memakai `<root>/<venv>/bin/python` dan jatuh ke `python3` kalau
venv tidak ada.

## Permission

Default deny. Semua leaf default ke nilai tertutup:

```yaml
permissions:
  network: false
  filesystem: null     # null | { mode: read|readwrite|none, paths: [] }
  shell: false
  secrets: []
```

Request permission dievaluasi sebelum spawn. Permintaan yang tidak
dideklarasikan agent ditolak dengan `PERMISSION_DENIED`. Bridge tidak pernah
memberi lebih dari yang dideklarasikan registry.

## Output contract

```json
{ "status": "success", "result": {}, "artifacts": [], "metadata": {} }
{ "status": "error",   "error": { "code": "MALFORMED_OUTPUT", "message": "..." }, "metadata": {} }
{ "status": "timeout", "error": { "code": "AGENT_TIMEOUT", "message": "..." }, "metadata": {} }
```

Kode error: `SPAWN_FAILED`, `RUNTIME_UNAVAILABLE`, `AGENT_EXIT_ERROR`,
`MALFORMED_OUTPUT`, `JSON_PARSE_ERROR`, `COLLECTION_ERROR`, `AGENT_TIMEOUT`,
`PERMISSION_DENIED`, `AGENT_NOT_FOUND`, `AGENT_DISABLED`,
`NO_ELIGIBLE_AGENT`, `ROUTING_DISABLED`, `INVALID_INPUT`.

`metadata` selalu memuat `execution_id`, `agent_id`, `agent_version`,
`started_at`, `duration_ms`, `status`, `exit_code`, `signal`, `tools_used`.

## Routing

Task teks dideteksi kapabilitasnya, lalu agent dengan capability yang cocok
disaring status dan urutan kematangan (production > validated >
experimental), lalu yang terbaik dipilih.

```text
"sanitasi PII dari teks ini"
  -> detectCapabilities -> { pii }
  -> filter: status in (experimental, validated, production)
  -> pick pii-sanitization
  -> run
  -> structured result
```

Router tidak pernah memakai nomor folder atau urutan direktori.

## Contoh alur

```text
user  -> "sanitasi data PII dari teks ini sebelum kirim ke LLM"
DSH   -> tool run_agent { task: "..." }
      -> capability router mendeteksi { pii }
      -> registry memberi pii-sanitization
      -> permission gate: network true (dideklarasikan), sisanya deny
      -> spawn python3 agent.py di venv agent
      -> tangkap stdout, validasi JSON
      -> { status: "success", result: {...}, metadata: {...} }
```

## Cara pakai

Tiga pola umum, dari yang paling sederhana ke yang paling presisi.

### Pola 1 — routing otomatis

Beri task teks natural. Bridge mendeteksi capability keyword dari task,
mencocokkan dengan registry, lalu memilih agent berstatus paling tinggi
di antara yang cocok.

```text
run_agent(task: "sanitize this text: john@example.com")
  -> keyword "pii" cocok, status experimental
  -> pilih pii-sanitization
```

Keyword yang dipakai router (substring match case-insensitive):

| Capability | Keyword yang memicu |
|---|---|
| `pii` | `pii`, `sanitize`, `scrub`, `anonymize`, `data privacy` |
| `research` | `research` |
| `security` | `security`, `audit` |
| `compliance` | `compliance` |
| `code-review` | `code-review`, `code review` |
| `qa` | `qa` |
| `data-analysis` | `data-analysis`, `data analysis` |
| `documentation` | `documentation` |
| `summary` | `summary` |

Tidak ada keyword yang cocok → `NO_ELIGIBLE_AGENT`. Tidak ada fallback
ke agent "umum" — ini invariant. Untuk task yang tidak cocok keyword
apa pun, pakai pola 2 atau 3.

### Pola 2 — sebut agent_id eksplisit

Gunakan ketika task Anda tidak mengandung keyword yang dikenal router
(tidak cocok `pii`, `security`, dll), atau ketika Anda sengaja mau
memaksa satu agent tertentu daripada mengandalkan substring match.

```text
run_agent(agent_id: "pii-sanitization", task: "bersihkan teks ini")
```

Periksa agent_id valid lewat `dsh500_list_agents` sebelum memanggil.

### Pola 3 — tunjukkan permission & context secara eksplisit

Gunakan ketika:
- Agent butuh env var yang tidak terdaftar di registry `secrets`,
- Anda ingin mempersempit scope (contoh: `permissions_override: { network: false }`),
- Atau timeout bawaan agent tidak cukup untuk task Anda.

Contoh: agent `documentation-writer` butuh `OPENAI_API_KEY` yang
sudah terdaftar di `permissions.secrets`; cukup lewat context tanpa
`permissions_override`:

```text
run_agent(
  agent_id: "documentation-writer",
  task: "tulis docstring untuk fungsi ini",
  context: { OPENAI_API_KEY: "sk-..." }
)
```

Contoh: pacu `pii-sanitization` tanpa jaringan (fail-closed tanpa
timeout 30 detik menunggu koneksi):

```text
run_agent(
  agent_id: "pii-sanitization",
  task: "bersihkan email di teks ini",
  permissions_override: { network: false },
  timeout_ms: 5000
)
```

### Ringkasan praktis

| Mau apa | Pakai pola |
|---|---|
| Task natural mengandung keyword yang dikenal | 1 (routing) |
| Task tidak cocok keyword, tapi tahu agent yang pas | 2 (agent_id) |
| Butuh env var tidak terdaftar di registry | 3 (context) |
| Mau paksa no-network / short timeout | 3 (permissions_override) |

### Contoh hasil

Hasil dikembalikan sebagai JSON dengan dua bentuk utama:

**Sukses** — agent selesai, status 0, stdout berisi JSON yang bisa di-parse:
```json
{ "status": "success", "result": {...}, "metadata": { "duration_ms": 3200 } }
```

**Error** — agent exit non-0 atau bridge gagal:
```json
{ "status": "error", "error": { "code": "AGENT_EXIT_ERROR", "message": "..." }, "metadata": { ... } }
```

**Timeout** — bridge membunuh proses sebelum agent selesai:
```json
{ "status": "timeout", "error": { "code": "AGENT_TIMEOUT" }, "metadata": { ... } }
```

Render ke console: `[success] agent="pii-sanitization" duration=3200ms`.

### Hindari

- Memanggil dengan `agent_id` salah — bridge langsung `AGENT_NOT_FOUND`.
  Cek registry dengan `dsh500_list_agents` terlebih dahulu.
- Mengandalkan `status: registered` atau `disabled` untuk dijalankan —
  bridge menolak keduanya dengan `AGENT_DISABLED`.
- Menambahkan permission yang tidak dideklarasikan registry — mis.
  `filesystem: read` untuk agent yang `permissions.filesystem: null`.
  Bridge akan `PERMISSION_DENIED`.
- Mengirim `task: ""` — bridge langsung `INVALID_INPUT`. Task wajib
  string non-kosong.

## Testing

```bash
# Unit test (116 test, ~1.5 detik)
npm test

# E2E test (2 test, ~31 detik; menjalankan Python agent sungguhan)
npm run test:e2e

# Full gate (build + unit + e2e)
npm run test:all
```

Test framework: vitest 4.1.11. Dua config terpisah — `vitest.config.ts`
(unit) dan `vitest.e2e.config.ts` (e2e) — karena vitest 4 tidak menerima
flag `--include` dari CLI.

| Area | File |
|---|---|
| Registry parse + validasi | `tests/registry.test.ts` (23 test) |
| Capability routing | `tests/router.test.ts` (36 test) |
| Permission gate | `tests/permissions.test.ts` (12 test) |
| Network denial enforcement | `tests/network-enforcement.test.ts` (6 test) |
| Bridge lifecycle (timeout, crash, output) | `tests/bridge.test.ts` (13 test) |
| Runtime backend config | `tests/runtime-backend.test.ts` (9 test) |
| LLM agent env leakage | `tests/llm-agents.test.ts` (9 test) |
| Container runtime stub contract | `tests/container-runtime.test.ts` (8 test) |
| Reference agent end-to-end | `tests/e2e-pii-agent.test.ts` (2 test) |

## Keamanan

- Command injection: `argv` dibangun dari template registry dan diteruskan
  ke execve sebagai array. Tidak ada `shell: true`, tidak ada string
  command yang di-`exec`.
- Path traversal: `root` di-normalisasi ke absolut dan divalidasi sebagai
  direktori yang ada. `resolveAgentRoot` menolak path yang keluar dari
  workspace root.
- Arbitrary executable: `argv[0]` hanya boleh `python3` atau path python
  di dalam venv agent. Registry tidak bisa menentukan executable bebas.
- Environment leakage: parent env di-scrub oleh `ctx.subprocess`; hanya
  secret yang dideklarasikan agent yang diteruskan.
- Registry validation menolak `agent_id` yang tidak pola, status di luar
  enum, capability di luar daftar, dan provenance yang tidak lengkap.
- Output validation: stdout harus berisi JSON yang bisa di-parse sebelum
  disebut sukses.

## Known limitations

Poin 1–2 terukur langsung lewat tool plugin di session ini (2026-10-06):
`dsh500_list_agents` mengembalikan 17 agent, `run_agent` terdaftar di tool
host dan bisa dipanggil. Routing keyword cocok dengan `src/router.ts`.

Poin 3–7 tetap berlaku:

| # | Batasan | Bukti |
|---|---|---|
| 3 | Shell execution boundary belum ada | `bwrap` tidak memblokir `os.system()` / `subprocess.call()` di dalam Python agent. Remediation: Landlock runner atau ContainerRuntime |
| 4 | ContainerRuntime adalah stub | `src/container-runtime.ts` mengembalikan `argv: []`; tidak ada Docker/Podman yang dijalankan. Kontrak stub diuji (`tests/container-runtime.test.ts`), implementasi nyata dijadwalkan Phase 9+ |
| 5 | Agent 03, 04, 08, 13 dari katalog tidak bisa dijalankan | Memakai `input()` interaktif, tidak cocok subprocess non-interaktif. Agent ini juga tidak terdaftar di registry |
| 6 | Katalog lokal berisi 21 agent, bukan 500 | Terdaftar di `agents/registry.yaml`: 17 |
| 7 | LLM agent belum teruji end-to-end | `code-review`, `documentation-writer`, `web-research` butuh `OPENAI_API_KEY` (+ `TAVILY_API_KEY` untuk `web-research`) plus jaringan keluar. Yang teruji: registry load, permission gate, router, dan bridge subprocess tanpa LLM call |

Poin 4 adalah satu-satunya batasan yang **bisa** ditutup di dalam repo ini (ContainerRuntime diimplementasi). Sisanya butuh keputusan di luar repo: akses jaringan keluar, atau perubahan upstream.

## RuntimeBackend

`src/runtime-backend.ts` dan `src/container-runtime.ts` menyediakan argv builder untuk tiga backend. Backend `bubblewrap` aktif di bridge saat `services.sandbox` tersedia atau fallback tanpa sandbox. Backend `container` mengaktifkan `docker|podman run --network=none --cap-drop=ALL --read-only …` bila binary runtime terdeteksi di host, dan mengembalikan sinyal `error` eksplisit bila tidak ada — tidak pernah mengklaim confinement yang tidak terjadi.

Bridge saat ini menggunakan bubblewrap secara default (hardcoded di `src/bridge.ts:159`). Knob config `runtimeBackend` belum ada di `PluginConfig` schema.

## Tool names

Plugin registers two tools with host DSH:

| Tool | Name |
|---|---|
| `list_agents` (this plugin) | `dsh500_list_agents` |
| `run_agent` (this plugin) | `run_agent` |

The host `dsh-subagent-control` registers `list_agents` natively. This
plugin uses the `dsh500_` prefix on its list tool to avoid collision.

## Provenance

| Item | Value |
|---|---|
| Catalog | `ashishpatel26/500-AI-Agents-Projects` @ `9beeb721c2af551bacaab827a76bddaecaa0ca5e` |
| Reference agent | `agents/21-pii-sanitization-agent` |
| DSH minimum version | `>=0.1.1-rc.1` (ditetapkan di `package.json`) |
| dsh-tools / dsh-sandbox / dsh-subprocess | `0.1.2-rc.1` (exact pin, di `package.json`) |

> **Catatan:** DSH tidak di-pin ke commit spesifik. Minimum versi
> `>=0.1.1-rc.1` ditentukan agar kompatibel dengan API yang dipakai
> plugin. Plugin tidak melakukan self-update — ia hanya membaca
> API yang sudah ada di harness.

Agent berstatus `experimental`, bukan `production-ready`.

