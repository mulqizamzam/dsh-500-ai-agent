# dsh-500-ai-agent

Plugin DeepSeek Harness yang menghubungkan katalog **500-AI-Agents-Projects**
(juga dikenal sebagai *ashishpatel26/500-AI-Agents-Projects*) ke dalam
DeepSeek Harness sehingga setiap agent di dalamnya bisa dipanggil
langsung dari console DSH, seperti panggilan ke tool biasa.

## Dalam satu kalimat

Plugin ini membuat agent-agent dari repositori publik
`ashishpatel26/500-AI-Agents-Projects` tersedia sebagai **tool yang bisa
dipanggil oleh DSH**, masing-masing berjalan di lingkungan terisolasi,
dikelola lewat registry, dan dilindungi oleh permission deny-by-default.

## Untuk siapa dokumen ini?

| Pembaca | Apa yang harus dibaca |
|---|---|
| Pemula / non-teknis | Bagian **Apa itu**, **Bagaimana cara kerja**, **Cara pakai (pola 1–3)**, **Troubleshooting** |
| Developer baru | Bagian **Arsitektur**, **Registry**, **Cara menambah agent**, **Keamanan** |
| Developer lanjutan | Bagian **Testing**, **Konfigurasi**, **RuntimeBackend**, **Known limitations**, **Build report** |
| Auditor | Bagian **Keamanan**, **Known limitations**, **Audit report** (`AUDIT_REPORT.md`) |

---

## Apa itu?

### DeepSeek Harness (DSH) — ringkasan singkat

DeepSeek Harness adalah *control plane* atau *orchestrator* untuk menjalankan
LLM agent secara lokal. Dari DSH kamu bisa:
- Menghubungkan ke berbagai model LLM (DeepSeek, OpenAI, dan lain-lain);
- Menjalankan *agent loop* (interaksi berulang dengan tool);
- Memasukkan plugin baru lewat sistem *bundle*.

Plugin `dsh-500-ai-agent` adalah salah satu plugin yang memperluas DSH
dengan menambahkan **catalogue agent** yang bisa dipilih berdasarkan *capability*
(tugas apa yang dibutuhkan).

### Katalog agent

Di
[ashishpatel26/500-AI-Agents-Projects](https://github.com/ashishpatel26/500-AI-Agents-Projects)
terdapat ratusan proyek Python kecil—masing-masing adalah satu agent untuk
satu tugas spesifik (misalnya sanitasi PII, review kode, riset web, ringkasan
berita). Plugin ini **tidak menyalin ulang** semua agent; ia hanya membaca
**registry YAML** yang berisi daftar agent mana saja yang mau dipakai,
lalu men spawn agent tersebut saat diminta.

> **Catatan penting:** katalog ini bernama "500" tetapi versi lokal saat ini
> hanya berisi **21 agent** (nomor 01–21). Yang terdaftar aktif di
> `agents/registry.yaml` saat ini: **17 agent**. Angka 500 adalah jumlah
> yang ada di upstream; tidak semua sudah di-cloning secara lokal.

---

## Bagaimana cara kerjanya?

```text
+---------------------------------------------------------------+
|                     Anda / AI Agent (user)                    |
|  "bersihkan data pribadi di teks ini sebelum kirim ke LLM"    |
+--------------------------+------------------------------------+
                           |
                           v
+---------------------------------------------------------------+
|                 DeepSeek Harness (host)                       |
|                                                               |
|   1. Menerjemahkan request jadi panggilan tool run_agent()    |
|   2. Meneruskan ke plugin dsh-500-ai-agent                    |
+---------------------------------------------------------------+
                           |
                           v
+---------------------------------------------------------------+
|              dsh-500-ai-agent (plugin)                        |
|                                                               |
|   +-- Capability Router                                       |
|     | Mendeteksi kata kunci di task:                          |
|     | "pii", "sanitize" → capability { pii }                  |
|   +-- Agent Registry                                          |
|     | Membaca agents/registry.yaml                            |
|     | Mencari agent dengan capability = { pii }               |
|     | Menemukan: pii-sanitization (status: experimental)      |
|   +-- Permission Manager                                      |
|     | Mengecek: agent punya network:true ?                   |
|     | Ya → lanjut. Tidak ada yang lain yang boleh lewat.     |
|   +-- Agent Bridge                                            |
|     | Spawn proses baru di venv piyaganda                       |
|     | Eksekusi python3 agent.py --text "..."                 |
|     | Tangkap stdout → validasi JSON                          |
|     | Kembalikan hasil ke DSH                                 |
+---------------------------------------------------------------+
                           |
                           v
+---------------------------------------------------------------+
|            Isolated Agent Runtime                             |
|                                                               |
|   python3 agent.py --text "teks asli"                         |
|     ↳ menjalankan code di venv sendiri                        |
|     ↳ tidak bisa mengakses jaringan/FS/shell parent            |
|     ↳ timeout 120 detik jika stuck                            |
+---------------------------------------------------------------+
```

### Kunci desain (5 prinsip)

1. **Registry-driven** — hanya agent yang terdaftar di `agents/registry.yaml`
   yang bisa dipanggil. Tidak ada pemindaian folder otomatis.
2. **Default deny** — semua permission (jaringan, filesystem, shell, secret)
   tertutup secara bawaan. Permission tambahan harus dideklarasikan di
   registry.
3. **Isolasi per-agent** — setiap agent punya `venv` sendiri. Crash satu
   agent tidak menjatuhkan agent lain atau DSH.
4. **Capability-first routing** — router memilih berdasarkan *apa yang
   dibutuhkan task*, bukan berdasarkan nomor folder atau urutan.
5. **Output contract** — setiap hasil dikembalikan dalam bentuk JSON yang
   sama: `{ status, result, error?, metadata }`.

---

## Cara pakai (untuk pengguna)

Ada tiga pola, dari yang paling sederhana sampai yang paling presisi.

### Pola 1 — routing otomatis (paling mudah)

Beri task dalam bahasa natural. Plugin akan mendeteksi kata kunci dan
memilih agent yang cocok secara otomatis.

```text
run_agent(task: "bersihkan email dan nama dari teks ini")
```

**Bagaimana dia bekerja?**
- Keyword `pii`, `sanitize` → capability `{ pii }` ditemukan.
- Router mencari di registry semua agent dengan capability `pii`.
- Dari yang cocok, dipilih yang statusnya paling tinggi:
  `production > validated > experimental`.
- Agent `pii-sanitization` terpilih (saat ini berstatus `experimental`).

**Keyword yang dikenali:**

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

> Jika tidak ada keyword yang cocok, hasil: `NO_ELIGIBLE_AGENT`.
> Router TIDAK punya fallback ke agent "umum".

---

### Pola 2 — sebut agent_id secara eksplisit

Gunakan ketika task Anda tidak mengandung keyword yang dikenal, atau Anda
sengaja ingin memaksa satu agent tertentu.

```text
run_agent(agent_id: "pii-sanitization", task: "bersihkan teks ini")
```

Sebelum memanggil, cek daftar agent_id yang valid:

```text
dsh500_list_agents()
```

---

### Pola 3 — tunjukkan permission & context secara eksplisit

Gunakan ketika Anda butuh salah satu dari hal berikut:
- Env var yang tidak terdaftar di registry `secrets` agent;
- Mempersempit scope (misalnya `network: false`);
- Menambah atau mengurangi timeout dari bawaan agent.

**Contoh 1 — kirim secret yang belum terdaftar:**

```text
run_agent(
  agent_id: "documentation-writer",
  task: "tulis docstring untuk fungsi ini",
  context: { OPENAI_API_KEY: "sk-..." }
)
```

**Contoh 2 — paksa tanpa jaringan + timeout pendek:**

```text
run_agent(
  agent_id: "pii-sanitization",
  task: "bersihkan email di teks ini",
  permissions_override: { network: false },
  timeout_ms: 5000
)
```

---

### Ringkasan praktis: pola mana yang dipakai?

| Situasi | Pola |
|---|---|
| Task natural, mengandung keyword yang dikenal | 1 (routing otomatis) |
| Task tidak cocok keyword, tapi tahu agent yang pas | 2 (agent_id eksplisit) |
| Butuh env var / secret tambahan | 3 (context) |
| Mau paksa no-network atau timeout pendek | 3 (permissions_override) |

---

## Contoh hasil

Hasil dikembalikan sebagai JSON dengan tiga bentuk utama.

**Sukses** — agent selesai, exit code 0, stdout berisi JSON yang valid:

```json
{
  "status": "success",
  "result": { ... },
  "artifacts": [],
  "metadata": {
    "execution_id": "...",
    "agent_id": "pii-sanitization",
    "agent_version": "1.0.0",
    "duration_ms": 3200,
    "started_at": "2026-10-06T...",
    "exit_code": 0
  }
}
```

**Error** — agent exit non-0 atau bridge gagal:

```json
{
  "status": "error",
  "error": {
    "code": "AGENT_EXIT_ERROR",
    "message": "..."
  },
  "metadata": { ... }
}
```

**Timeout** — bridge membunuh proses sebelum agent selesai:

```json
{
  "status": "timeout",
  "error": {
    "code": "AGENT_TIMEOUT",
    "message": "..."
  },
  "metadata": { ... }
}
```

Render sederhana ke console:
```
[success] agent="pii-sanitization" duration=3200ms
```

---

## Hal yang harus dihindari

| Jangan lakukan | Akibat |
|---|---|
| Memanggil dengan `agent_id` yang salah | `AGENT_NOT_FOUND` |
| Memanggil agent berstatus `registered` atau `disabled` | `AGENT_DISABLED` |
| Meminta permission yang tidak dideklarasikan registry (mis. `filesystem: read` untuk agent yang `null`) | `PERMISSION_DENIED` |
| Mengirim `task: ""` (kosong) | `INVALID_INPUT` |
| Mengandalkan `status: experimental` berarti production-ready | Belum — hanya `validated` atau `production` yang layak produksi |

---

## Arsitektur (detail teknis)

```text
User
  |
  v
DeepSeek Harness (host)
  |
  +-- Agent Loop / LLM / Tools / Session / Policy
         |
         v
  dsh-500-ai-agent plugin
         |
         +-- Capability Router     deteksi capability dari task text
         +-- Agent Registry        baca + validasi agents/registry.yaml
         +-- Permission Manager    default deny, grant eksplisit
         +-- Agent Bridge          spawn via ctx.subprocess
         |
         v
  Isolated Agent Runtime
         |
         +-- Python Agent (per-agent venv / process tree)
         +-- ContainerRuntime (stub, Phase 9+)
```

**Registri adalah sumber kebenaran tunggal.** Bridge tidak memindai
filesystem untuk mencari `agent.py`; hanya entri yang terdaftar di
`agents/registry.yaml` yang bisa dipanggil.

---

## Instalasi

### Langkah 1 — install & build plugin

```bash
cd dsh-custom/plugins/dsh-500-ai-agent
npm install
npm run build
```

### Langkah 2 — aktifkan di profil DSH

Tambahkan baris berikut ke
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: 500-ai-agent
      name: dsh-500-ai-agent
      config:
        registryPath: /home/administrator/agent-workspace/dsh-custom/plugins/dsh-500-ai-agent/agents/registry.yaml
        workspaceRoot: /home/administrator/agent-workspace/dsh-custom/plugins/dsh-500-ai-agent
        enableRouting: true
        logLevel: info
```

Lalu jalankan `pnpm install` di `$DSH_HOME/profiles/web`.

### Langkah 3 — restart DSH

Restart `dsh web` setelah config berubah.
> **Restart adalah aksi operator** — agen tidak menjalankannya.

### Langkah 4 — verifikasi

Dari sesi baru, panggil tool:

```text
dsh500_list_agents()
```

Harusnya mengembalikan daftar agent (saat ini 17 agent).

---

## Konfigurasi

| Knob | Default | Arti |
|---|---|---|
| `registryPath` | `agents/registry.yaml` | Lokasi registry, relatif ke `workspaceRoot` |
| `workspaceRoot` | `''` (cwd) | Basis untuk path relatif agent |
| `enableRouting` | `true` | Auto-pilih agent dari task bila `agent_id` absen |
| `logLevel` | `info` | `info` / `warn` / `error` |

---

## Registry

### Format satu entri

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
    - "--context"
    - "general"
  capabilities: [pii, security, compliance, general]
  permissions:                      # default deny
    network: true
    filesystem: null
    shell: false
    secrets:
      - TRUSTBOOST_API_BASE
      - OPENAI_MODEL
      - REASONING_EFFORT
  resources:
    timeout_ms: 120000
  source:                           # provenance (asal-usul)
    repository: ashishpatel26/500-AI-Agents-Projects
    path: agents/21-pii-sanitization-agent
    commit: 9beeb721c2af551bacaab827a76bddaecaa0ca5e
  status: experimental              # registered|experimental|validated|production|disabled
  root: ../../../../500-AI-Agents-Projects/agents/21-pii-sanitization-agent
  venv: .venv                       # opsional; jika absen pakai python3 sistem
```

**Penjelasan field penting:**

- `root` relatif terhadap direktori file registry, **bukan CWD**.
  Bridge menormalkan `root` ke path absolut saat parse.
- `entrypoint_args` adalah argv posisional: tiap elemen literal atau
  placeholder `{{task}}` / `{{timeout_ms}}` / `{{nama_context}}`.
  Nilai yang diresolusi diteruskan ke `execve` apa adanya, tanpa quoting shell.
- `capabilities` adalah tag yang dipakai router untuk matching.
- `permissions` mengikuti pola **default deny** — hanya hal yang
  dideklarasikan yang diizinkan.
- `status` menentukan apakah agent boleh dipanggil atau tidak
  (lihat tabel status di bawah).

### Status agent

| Status | Bisa dipanggil? | Arti |
|---|---|---|
| `registered` | Tidak | Baru terdaftar, belum diuji |
| `experimental` | Ya | Sudah diuji sekali, hasilnya berhasil |
| `validated` | Ya | Uji lengkap lulus |
| `production` | Ya | Layak produksi |
| `disabled` | Tidak | Dinonaktifkan (bisa diaktifkan kembali) |

Agent berstatus `registered` atau `disabled` ditolak dengan error
`AGENT_DISABLED`.

---

## Cara menambah agent baru

1. Pastikan agent sudah ada di katalog lokal
   (`500-AI-Agents-Projects/agents/<nomor>-<nama>-agent/`).
2. Tambah entri YAML di `agents/registry.yaml` dengan format sesuai
   contoh di atas.
3. Isi `capabilities` dengan tag yang valid:

   ```
   research, code-review, pii, summary, documentation, security,
   compliance, qa, data-analysis, general
   ```

4. Isi `source` dengan repository, path, dan commit (provenance).
5. Set `status: registered` terlebih dahulu.
6. Setelah invocation pertama berhasil, naikkan ke `experimental`.
7. Setelah test lengkap lulus, naikkan ke `validated`.

> **Capability tag baru** perlu ditambah di `src/types.ts`
> (`AgentCapability`) dan `src/registry.ts` (`VALID_CAPABILITIES`)
> lebih dulu sebelum dipakai di registry.

---

## Isolasi runtime

Setiap agent berjalan sebagai **proses terpisah** di bawah `cwd` miliknya
sendiri. Bridge memakai `ctx.subprocess.spawn` dari DSH, yang sudah:

- **Membersihkan environment**: nama yang cocok `KEY`, `PASSWORD`,
  `SECRET`, `TOKEN` serta semua `DSH_*` dibuang dari parent env,
  kecuali yang diteruskan eksplisit lewat `spec.env` atau
  `permissions.secrets` di registry.
- **Terminate tree-scoped**: POSIX menyinyal process group,
  Windows memakai `taskkill /T`.
- **Kill escalation**: `spec.signal` memicu terminasi,
  `graceMs` mengatur jeda eskalasi sebelum SIGKILL.

### Isolasi per-agent via venv

Setiap agent punya virtual environment sendiri. Bridge:

1. Mencoba menggunakan venv di `<root>/<venv>` (misalnya `agent/.venv`).
2. Jika katalog RO (read-only) atau venv tidak ada, fallback ke
   `<workspaceRoot>/venvs/<agentId>/.dsh500-venv`.
3. Jika venv tidak ditemukan sama sekali, jatuh ke `python3` sistem.

Ini menjamin dependency agent A tidak bersinggungan dengan agent B.

---

## Permission

### Prinsip: default deny

Semua leaf permission default ke nilai tertutup:

```yaml
permissions:
  network: false
  filesystem: null     # null | { mode: read|readwrite|none, paths: [] }
  shell: false
  secrets: []
```

**Makna setiap leaf:**

| Field | `false` / `null` / `[]` | Arti |
|---|---|---|
| `network` | `false` | Tidak ada akses jaringan keluar |
| `filesystem` | `null` | Tidak ada akses filesystem |
| | `{ mode: 'read', paths: [...] }` | Baca saja path tertentu |
| | `{ mode: 'readwrite', paths: [...] }` | Baca+tulis path tertentu |
| `shell` | `false` | Tidak boleh jalankan shell command |
| `secrets` | `[]` | Tidak ada secret yang diteruskan |
| | `["OPENAI_API_KEY"]` | Hanya env var ini yang boleh diteruskan |

Request permission dievaluasi **sebelum spawn**. Permintaan yang tidak
dideklarasikan agent ditolak dengan `PERMISSION_DENIED`. Bridge tidak pernah
memberi lebih dari yang dideklarasikan registry.

### Secret gating (bagaimana secret diteruskan)

- Jika request **tidak menyebut** `secrets`, bridge meneruskan **semua**
  secret yang dideklarasikan di registry.
- Jika request **menyebut** `secrets`, set itu wajib menjadi **subset**
  dari declared secrets. Ditolak jika ada nama di luar declared.
- Nilai secret tidak pernah dicetak di log — hanya agent_id, duration,
  dan exit code yang terekam.

---

## Output contract

Setiap hasil dikembalikan dalam schema yang sama:

```json
{
  "status": "success | error | timeout",
  "result": {},
  "artifacts": [],
  "error": null,
  "metadata": {}
}
```

### Kode error

| Code | Arti |
|---|---|
| `SPAWN_FAILED` | Gagal menspawn proses (path salah, permission ditolak) |
| `RUNTIME_UNAVAILABLE` | Python/binary runtime tidak tersedia |
| `AGENT_EXIT_ERROR` | Agent exit non-0 |
| `MALFORMED_OUTPUT` | Agent output bukan JSON valid |
| `JSON_PARSE_ERROR` | Gagal parse stdout sebagai JSON |
| `COLLECTION_ERROR` | Gagal mengumpulkan output |
| `AGENT_TIMEOUT` | Timeout habis sebelum agent selesai |
| `PERMISSION_DENIED` | Request permission tidak diizinkan registry |
| `AGENT_NOT_FOUND` | `agent_id` tidak ada di registry |
| `AGENT_DISABLED` | Agent berstatus `registered` atau `disabled` |
| `NO_ELIGIBLE_AGENT` | Tidak ada agent dengan capability yang cocok |
| `ROUTING_DISABLED` | `enableRouting: false` di config |
| `INVALID_INPUT` | `task` kosong atau input tidak valid |

### Metadata (selalu ada)

```json
{
  "execution_id": "uuid",
  "agent_id": "pii-sanitization",
  "agent_version": "1.0.0",
  "started_at": "ISO-8601",
  "duration_ms": 3200,
  "status": "success",
  "exit_code": 0,
  "signal": null,
  "tools_used": []
}
```

---

## Routing

### Alur routing

```text
"bersihkan data pribadi dari teks ini sebelum kirim ke LLM"
  ↓
capability router mendeteksi keyword → { pii }
  ↓
registry filter: status in (experimental, validated, production)
  ↓
maturity order: production > validated > experimental
  ↓
pilih agent terbaik (pii-sanitization)
  ↓
jalan → hasil
```

Router **tidak pernah** memakai nomor folder atau urutan direktori.
Pemilihan murni berbasis capability metadata dan status kematangan.

---

## Testing

```bash
# Unit test (116 test, ~1.5 detik)
npm test

# E2E test (2 test, ~31 detik; menjalankan Python agent sungguhan)
npm run test:e2e

# Full gate (build + unit + e2e)
npm run test:all
```

Test framework: **vitest 4.1.11**. Dua config terpisah —
`vitest.config.ts` (unit) dan `vitest.e2e.config.ts` (e2e) — karena
vitest 4 tidak menerima flag `--include` dari CLI.

### Daftar test per area

| Area | File | Jumlah |
|---|---|---|
| Registry parse + validasi | `tests/registry.test.ts` | 23 |
| Capability routing | `tests/router.test.ts` | 36 |
| Permission gate | `tests/permissions.test.ts` | 12 |
| Network denial enforcement | `tests/network-enforcement.test.ts` | 6 |
| Bridge lifecycle (timeout, crash, output) | `tests/bridge.test.ts` | 13 |
| Runtime backend config | `tests/runtime-backend.test.ts` | 9 |
| LLM agent env leakage | `tests/llm-agents.test.ts` | 9 |
| Container runtime stub contract | `tests/container-runtime.test.ts` | 8 |
| Reference agent end-to-end | `tests/e2e-pii-agent.test.ts` | 2 |
| **Total** | | **118** |

---

## Keamanan

### Apa yang sudah dilindungi

| Ancaman | Mekanisme |
|---|---|
| Command injection | `argv` dibangun dari template registry dan diteruskan ke `execve` sebagai array. Tidak ada `shell: true`, tidak ada string command yang di-`exec`. |
| Path traversal | `root` dinormalisasi ke absolut dan divalidasi sebagai direktori yang ada. `resolveAgentRoot` menolak path yang keluar dari workspace root. |
| Arbitrary executable | `argv[0]` hanya boleh `python3` atau path python di dalam venv agent. Registry tidak bisa menentukan executable bebas. |
| Environment leakage | Parent env di-scrub oleh `ctx.subprocess`; hanya secret yang dideklarasikan agent yang diteruskan. |
| Registry injection | Validasi menolak `agent_id` yang tidak pola, status di luar enum, capability di luar daftar, dan provenance yang tidak lengkap. |
| Output poisoning | Stdout harus berisi JSON yang bisa di-parse sebelum disebut sukses. |

### Apa yang BELUM sepenuhnya terlindungi

| Ancaman | Status | Remediasi |
|---|---|---|
| Shell execution (`os.system()`, `subprocess.call()`) | ⚠️ **Tidak diblokir** bubblewrap tidak memblokir execve dari dalam Python. Landlock runner atau ContainerRuntime diperlukan untuk menutup ini. |
| Container runtime | Stub saja — belum wired ke bridge | Implementasi nyata dijadwalkan Phase 9+ |

---

## Known limitations

### Yang sudah diverifikasi (terukur)

| # | Batasan | Bukti |
|---|---|---|
| 1 | `dsh500_list_agents` mengembalikan **17 agent** (VERIFIED 2026-10-06 via tool call) | `agents/registry.yaml` + live tool call |
| 2 | `run_agent` terdaftar di tool host dan bisa dipanggil | Live tool call |
| 3 | Routing keyword cocok dengan implementasi di `src/router.ts` | 36 unit test di `router.test.ts` |

### Yang masih bersifat batasan (tetap berlaku)

| # | Batasan | Bukti / Status |
|---|---|---|
| 4 | **Shell execution boundary belum ada** | `bwrap` tidak memblokir `os.system()` / `subprocess.call()` di dalam Python agent. Remediation: Landlock runner atau ContainerRuntime |
| 5 | **ContainerRuntime adalah stub** | `src/container-runtime.ts` mengembalikan `argv: []`; tidak ada Docker/Podman yang dijalankan. Kontrak stub diuji (`tests/container-runtime.test.ts`), implementasi nyata dijadwalkan Phase 9+ |
| 6 | **Agent interaktif (03, 04, 08, 13) tidak bisa dijalankan** | Memakai `input()` interaktif, tidak cocok untuk subprocess non-interaktif. Agent ini juga belum terdaftar di registry |
| 7 | **Katalog lokal berisi 21 agent, bukan 500** | Register aktif: 17. Angka 500 adalah nama repositori upstream |
| 8 | **LLM agent belum teruji end-to-end** | `code-review`, `documentation-writer`, `web-research` butuh `OPENAI_API_KEY` (+ `TAVILY_API_KEY` untuk `web-research`) plus jaringan keluar. Yang teruji: registry load, permission gate, router, dan bridge subprocess tanpa LLM call |

> **Catatan:** Poin 5 adalah satu-satunya batasan yang **bisa** ditutup di
> dalam repo ini (ContainerRuntime diimplementasi). Sisanya butuh keputusan
> di luar repo: akses jaringan keluar, atau perubahan upstream.

---

## RuntimeBackend

`src/runtime-backend.ts` dan `src/container-runtime.ts` menyediakan argv
builder untuk tiga backend:

| Backend | Kapan dipakai | Ketersediaan |
|---|---|---|
| `bubblewrap` | Default saat `services.sandbox` tersedia di host | ✅ Aktif (hardcoded di `src/bridge.ts:159`) |
| `container` | Bila Docker/Podman terdeteksi di host | 🟡 Stub — belum wired ke bridge |
| `local` | Fallback tanpa sandbox | ✅ Ada, tapi tanpa confinement |

**Bubblewrap** (`bwrap`):
- `--ro-bind / /` — root filesystem read-only
- `--dev /dev` — akses `/dev` terbatas
- `--unshare-pid` — isolasi PID
- `--unshare-net` — **memblokir jaringan** (terukur: socket ke `1.1.1.1:443` gagal)
- **Kekurangan**: tidak bisa memblokir `os.system()` / `subprocess.call()` dari dalam Python

**Container** (stub):
- Pola: `docker|podman run --network=none --cap-drop=ALL --read-only …`
- Menolak claim confinement bila Docker tidak tersedia — tidak pernah
  mengklaim keamanan yang tidak terjadi.

> Knob config `runtimeBackend` belum tersedia di `PluginConfig` schema.
> Saat ini backend dipilih secara hardcoded.

---

## Tool names

Plugin mendaftarkan dua tool ke host DSH:

| Tool internal | Nama tool di host |
|---|---|
| `list_agents` (plugin ini) | `dsh500_list_agents` |
| `run_agent` (plugin ini) | `run_agent` |

Nama `dsh500_list_agents` dipakai untuk menghindari benturan dengan tool
`list_agents` milik host `dsh-subagent-control`.

---

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

Agent berstatus `experimental`, **bukan** `production-ready`.

---

## Status

**Source lengkap, build clean, 116 unit test + 2 e2e test lulus, plugin
ter-mount di profil web.**

VERIFIED 2026-10-06:
- `dsh500_list_agents` dan `run_agent` terdaftar di tool host
- Registry berisi 17 agent

Detail lengkap Build Report ada di [`BUILD_REPORT.md`](BUILD_REPORT.md).

---

## Dokumen pendukung

| Dokumen | Isi |
|---|---|
| [`PRD.md`](PRD.md) | Product Requirements — tujuan, goals, non-goals, arsitektur |
| [`ASSUMPTIONS.md`](ASSUMPTIONS.md) | Asumsi proyek + koreksi yang terbukti salah saat implementasi |
| [`BUILD_REPORT.md`](BUILD_REPORT.md) | Laporan build, test count, live validation, gate Phase 3 |
| [`INSTALL-WEB.md`](INSTALL-WEB.md) | Petunjuk instalasi plugin ke profil web (aksi operator) |
| [`PHASE3-CLOSE.md`](PHASE3-Close.md) | Penutupan Phase 3 — apa selesai, apa blokir, apa untested |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | Audit keamanan source code |
| [`agents/registry.yaml`](agents/registry.yaml) | Daftar agent yang terdaftar (sumber kebenaran) |
| [`src/types.ts`](src/types.ts) | Tipe TypeScript — `AgentCapability`, `PluginConfig`, dll |
| [`src/registry.ts`](src/registry.ts) | Parser + validator registry |
| [`src/router.ts`](src/router.ts) | Capability router |
| [`src/permissions.ts`](src/permissions.ts) | Permission evaluator |
| [`src/bridge.ts`](src/bridge.ts) | Agent bridge — spawn, confine, timeout, validate |
| [`src/runtime-backend.ts`](src/runtime-backend.ts) | Bubblewrap + container backend builder |
| [`src/container-runtime.ts`](src/container-runtime.ts) | Container runtime stub |
