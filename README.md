# dsh-500-ai-agent

Panduan pemula berbahasa Indonesia. Dokumen ini menuntun pembaca dari mesin
kosong sampai bisa memanggil agent lewat DeepSeek Harness (DSH).

Aturan keterlacakan dokumen ini: setiap perintah disalin dari `package.json`,
`INSTALL-WEB.md`, atau `cordis.patch.yml`. Setiap path dan nama variabel berasal
dari file di repo ini. Hal yang tidak didukung file ditandai dengan kalimat
**Perlu dikonfirmasi**. Semua nilai contoh di dokumen ini adalah placeholder,
bukan secret asli.

---

## 1. Overview

`dsh-500-ai-agent` adalah plugin DeepSeek Harness. DSH adalah orkestrator
lokal untuk menjalankan agent LLM. Plugin ini memaparkan agent Python dari
katalog `ashishpatel26/500-AI-Agents-Projects` sebagai tool yang bisa dipanggil
DSH (deskripsi di `package.json`, implementasi di `src/index.ts`).

Cara kerjanya dalam tiga kalimat. Daftar agent yang boleh dipanggil hanya
berasal dari `agents/registry.yaml`, tidak dari pemindaian folder (komentar di
`src/types.ts`). Setiap panggilan melewati gerbang izin default-tutup, lalu agent
dijalankan sebagai proses Python terisolasi (`src/permissions.ts`,
`src/runtime-manager.ts`, `src/bridge.ts`). Hasil selalu dikembalikan sebagai
JSON dengan bentuk yang sama (tipe `AgentInvocationResult` di `src/bridge.ts`).

Plugin mendaftarkan dua tool ke host DSH (nama dan deskripsi dari `src/index.ts`):

| Tool di host | Fungsi |
|---|---|
| `dsh500_list_agents` | Menampilkan semua agent di registry beserta status dan capability |
| `run_agent` | Menjalankan satu agent untuk satu task |

Registry saat ini berisi 17 entri dan semuanya berstatus `experimental`
(dihitung dari `agents/registry.yaml`). Semua agent boleh dipanggil untuk uji
coba, tetapi belum ada yang berstatus produksi.

---

## 2. Prerequisites

| Kebutuhan | Versi yang diminta file | Cara cek |
|---|---|---|
| Node.js | `>=20` (field `engines` di `package.json`) | `node --version` |
| npm | Lockfile yang ada adalah `package-lock.json`, jadi paket ini memakai npm | `npm --version` |
| `python3` | Tiap entri registry meminta runtime `python` versi `3.11` (`agents/registry.yaml`) | `python3 --version` |
| `bwrap` (bubblewrap) | Dipakai untuk menolak jaringan dan mengunci filesystem (`src/bridge.ts`, `src/runtime-backend.ts`) | `bwrap --version` |
| `docker` atau `podman` | Opsional. Hanya perlu bila memakai backend container (`src/container-runtime.ts`) | `docker --version` |
| Checkout katalog upstream | Folder agent dibaca dari field `root` tiap entri registry | Lihat baris `root` di `agents/registry.yaml` |
| Kunci API | Hanya perlu saat memanggil agent tertentu, lihat tabel secret di seksi 4 | Tidak ada perintah cek kunci di repo |

Tidak ada akun, layanan berbayar, atau signup yang diwajibkan untuk memasang
plugin. Kunci API hanya dibutuhkan saat memanggil agent LLM, dan itu discussed
di seksi 4.

Nilai terukur di host ini pada 2026-10-07:

| Tool | Nilai terukur |
|---|---|
| `node` | v24.19.0 |
| `npm` | 11.17.0 |
| `python3` | Python 3.14.4 |
| `bwrap` | `/usr/bin/bwrap`, bubblewrap 0.11.1 |
| `docker` | `/usr/bin/docker` ada |
| `podman` | tidak ditemukan |

Dua hal penting untuk pemula. Pertama, registry meminta Python 3.11 sementara
host ini memakai Python 3.14.4. Apakah semua agent berjalan benar di 3.14 adalah
**Perlu dikonfirmasi**. Kedua, `bwrap` hanya ada di Linux, sehingga perilaku
plugin di sistem operasi lain adalah **Perlu dikonfirmasi**.

Status lockfile:

| File | Status | Arti |
|---|---|---|
| `package-lock.json` | Ada | Instalasi plugin memakai `npm install` |
| `pnpm-lock.yaml` | Tidak ada | Jangan memakai pnpm di folder plugin ini |

Perintah `pnpm install` hanya dipakai di folder profil DSH
(`$DSH_HOME/profiles/web`), bukan di folder plugin. Itu berasal dari
`INSTALL-WEB.md`.

---

## 3. Installation

### Langkah 1, clone repo plugin

```bash
git clone https://github.com/mulqizamzam/dsh-500-ai-agent.git
```

URL itu dibaca dari `git config --get remote.origin.url` di repo ini.

### Langkah 2, install dependency plugin

```bash
cd dsh-500-ai-agent
```

```bash
npm install
```

`npm install` memasang dependency sesuai `package-lock.json`.

### Langkah 3, build plugin

```bash
npm run build
```

Perintah itu menjalankan `tsc -b tsconfig.json`, disalin verbatim dari field
`scripts` di `package.json`, dan menghasilkan folder `lib/`. Folder `lib/` tidak
di-commit karena sudah ada di `.gitignore`.

Bukti bahwa build berhasil:

```bash
ls lib/index.js
```

Kalau file itu muncul, build selesai.

### Langkah 4, pastikan checkout katalog upstream ada

Tiap entri registry menunjuk folder agent lewat field `root` yang relatif,
contohnya `../../../../project/500-AI-Agents-Projects/agents/21-pii-sanitization-agent`.
Path relatif itu diselesaikan terhadap direktori file registry, yaitu folder
`agents/` (lihat `parseRegistryYaml` di `src/registry.ts`). Untuk repo
`dsh-500-ai-agent` di path host ini, folder tersebut berarti
`/home/administrator/agent-workspace/project/500-AI-Agents-Projects`.

Cek apakah checkout itu ada:

```bash
ls ../../../../project/500-AI-Agents-Projects/agents
```

Perintah ini dijalankan dari folder `agents/` di repo plugin. Kalau folder tidak
ada, setiap entri registry akan ditolak dengan pesan
`root "..." does not exist` saat plugin dimuat, dan `dsh500_list_agents`
mengembalikan daftar kosong. Checkout katalog upstream beserta commit
`9beeb72` ada di host ini dan sudah terverifikasi.

### Langkah 5, pasang plugin ke profil web DSH

Ini aksi operator karena menulis ke `$DSH_HOME/profiles/web` berada di luar
jangkauan sandbox agen.

Tambahkan dependency di `$DSH_HOME/profiles/web/package.json`, disalin verbatim
dari `INSTALL-WEB.md`:

```json
"dsh-500-ai-agent": "link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-500-ai-agent"
```

Tambahkan juga `"dsh-500-ai-agent"` ke daftar `"dsh.profile.bundles"` di file
yang sama.

Lalu tambahkan blok berikut ke `$DSH_HOME/profiles/web/cordis.patch.yml`,
disalin verbatim dari `INSTALL-WEB.md`:

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

Path absolut di blok itu adalah contoh di host ini. Ganti dengan path milik Anda.

### Langkah 6, jalankan pnpm install di folder profil

```bash
cd "$DSH_HOME/profiles/web"
```

```bash
pnpm install
```

Perintah itu membuat symlink `node_modules/dsh-500-ai-agent` yang menunjuk ke
folder plugin, dijelaskan di `INSTALL-WEB.md`. Symlink tersebut sudah terverifikasi
ada di host ini.

### Langkah 7, restart DSH

Restart membaca ulang komposisi profil. Restart adalah aksi operator dan agen
tidak menjalankannya, dinyatakan eksplisit di `INSTALL-WEB.md`.

### Langkah 8, verifikasi

Dari sesi DSH baru, panggil tool dari console:

```text
dsh500_list_agents()
```

Keluaran yang benar di host ini:

```text
Found 17 agent(s):
  - pii-sanitization (experimental): pii, security, compliance, general
  - code-review (experimental): code-review, security, general
  ...
```

Kalau tool tidak dikenal atau daftarnya kosong, plugin belum termuat. Kembali ke
langkah 5 sampai 7.

---

## 4. Configuration

### 4.1 Konfigurasi plugin

Kunci konfigurasi berasal dari `Config` dan `PluginConfig` di `src/index.ts`.
Semua nilai default di bawah disalin dari file itu.

| Kunci | Default | Arti | Contoh aman |
|---|---|---|---|
| `registryPath` | `agents/registry.yaml` | Lokasi file registry. Path relatif digabung dengan `workspaceRoot`, path absolut dipakai apa adanya (`ensureRegistry` di `src/index.ts`) | `agents/registry.yaml` |
| `workspaceRoot` | `''` yang berarti folder kerja proses saat ini (`config.workspaceRoot \|\| process.cwd()`) | Dasar untuk path relatif | `/path/ke/plugin` (placeholder) |
| `enableRouting` | `true` | Bila `true`, panggilan tanpa `agent_id` mencari agent otomatis lewat router. Bila `false`, panggilan tanpa `agent_id` ditolak dengan `ROUTING_DISABLED` | `true` |
| `logLevel` | `info` | Level log plugin | `info` |
| `defaultContext` | `{}` | Variabel context default untuk tiap agent. Nilai berbentuk `env:NAMA_VAR` diganti dengan isi environment variable tersebut (`resolveDefaultContext` di `src/index.ts`) | `{"OPENAI_API_KEY": "env:OPENAI_API_KEY"}` (placeholder) |

Catatan jujur tentang `logLevel`: skema `Schema.string()` di `src/index.ts`
menerima string apa pun, sedangkan helper log memakai `info`, `warn`, dan
`error`. Nilai di luar tiga itu adalah **Perlu dikonfirmasi**.

Konfigurasi di `cordis.patch.yml` milik repo ini memakai `registryPath` relatif
serta `workspaceRoot` absolut. `INSTALL-WEB.md` memakai `registryPath` absolut.
Keduanya valid karena `src/index.ts` menggabungkan path relatif dengan
`workspaceRoot`.

### 4.2 Format entri registry

Satu entri per agent di `agents/registry.yaml`. Aturan validasi berasal dari
fungsi `validateEntry` di `src/registry.ts`. Contoh entri `pii-sanitization` yang
dipersingkat dari file asli:

```yaml
pii-sanitization:
  agent_id: pii-sanitization
  name: PII Sanitization Agent
  version: 1.0.0
  runtime:
    type: python
    version: "3.11"
  entrypoint: agent.py
  entrypoint_args:
    - "--text"
    - "{{task}}"
    - "--tx-hash"
    - "TRIAL"
    - "--context"
    - "general"
  capabilities:
    - pii
    - security
    - compliance
    - general
  permissions:
    network: true
    filesystem: null
    shell: false
    secrets:
      - TRUSTBOOST_API_BASE
      - OPENAI_MODEL
      - REASONING_EFFORT
  resources:
    timeout_ms: 120000
  source:
    repository: ashishpatel26/500-AI-Agents-Projects
    path: agents/21-pii-sanitization-agent
    commit: 9beeb721c2af551bacaab827a76bddaecaa0ca5e
  status: experimental
  root: ../../../../project/500-AI-Agents-Projects/agents/21-pii-sanitization-agent
```

Penjelasan field yang paling sering membingungkan:

- `root` ditulis relatif terhadap direktori file registry, bukan folder kerja
  proses, lalu dinormalkan jadi path absolut saat parse (`src/registry.ts`).
- `entrypoint_args` adalah template argv. Elemen `{{task}}` diisi dari task
  pemanggil, `{{timeout_ms}}` dari timeout, dan nama lain dari `context`
  (`buildAgentArgs` di `src/bridge.ts`). Nilai diteruskan apa adanya tanpa
  quoting shell.
- `capabilities` hanya boleh berisi 10 tag dari `VALID_CAPABILITIES` di
  `src/registry.ts`: `research`, `code-review`, `pii`, `summary`,
  `documentation`, `security`, `compliance`, `qa`, `data-analysis`, `general`.
- `agent_id` harus cocok pola `^[a-z][a-z0-9-]{0,63}$` (`src/registry.ts`).
- `venv` bersifat opsional. Kalau ada, bridge memakai Python dari venv itu.
  Kalau tidak ada, bridge memakai `python3` sistem (`resolvePythonBinary` di
  `src/bridge.ts`).

Status agent menentukan boleh tidaknya dipanggil (`src/index.ts`):

| Status | Bisa dipanggil | Arti |
|---|---|---|
| `registered` | Tidak | Baru terdaftar, belum diuji. Ditolak `AGENT_DISABLED` |
| `experimental` | Ya | Sudah dicoba dipanggil, belum siap produksi |
| `validated` | Ya | Lulus uji lengkap |
| `production` | Ya | Disetujui untuk pemakaian produksi |
| `disabled` | Tidak | Dinonaktifkan. Ditolak `AGENT_DISABLED` |

### 4.3 Daftar 17 agent terdaftar

Semua baris dibaca dari `agents/registry.yaml`. Semua entri memakai runtime
`python` versi `3.11`, `entrypoint: agent.py`, `network: true`,
`filesystem: null`, `shell: false`, dan status `experimental`.

| `agent_id` | `capabilities` | `timeout_ms` | `venv` |
|---|---|---|---|
| `pii-sanitization` | `pii`, `security`, `compliance`, `general` | 120000 | tidak ada |
| `code-review` | `code-review`, `security`, `general` | 180000 | `.dsh500-venv` |
| `documentation-writer` | `documentation`, `general` | 180000 | `.dsh500-venv` |
| `web-research` | `research`, `summary`, `general` | 240000 | `.dsh500-venv` |
| `email-drafting` | `documentation`, `general` | 120000 | tidak ada |
| `news-summarizer` | `summary`, `research`, `general` | 120000 | tidak ada |
| `github-issue-triager` | `code-review`, `general` | 120000 | tidak ada |
| `resume-parser` | `data-analysis`, `general` | 120000 | tidak ada |
| `meeting-notes` | `documentation`, `summary`, `general` | 120000 | tidak ada |
| `stock-research` | `research`, `data-analysis`, `general` | 120000 | tidak ada |
| `travel-planner` | `general`, `research` | 120000 | tidak ada |
| `social-media` | `documentation`, `general` | 120000 | tidak ada |
| `unit-test-generator` | `code-review`, `qa`, `general` | 120000 | tidak ada |
| `recipe-agent` | `general` | 120000 | tidak ada |
| `job-application` | `documentation`, `general` | 120000 | tidak ada |
| `competitive-analysis` | `research`, `data-analysis`, `general` | 120000 | tidak ada |
| `multi-agent-debate` | `general`, `research` | 120000 | tidak ada |

Hanya 3 entri punya `venv`, yaitu `code-review`, `documentation-writer`, dan
`web-research`. Empat belas entri lain memakai `python3` sistem.

Secret yang dideklarasikan tiap agent:

| `agent_id` | `secrets` |
|---|---|
| `pii-sanitization` | `TRUSTBOOST_API_BASE`, `OPENAI_MODEL`, `REASONING_EFFORT` |
| `code-review` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `REASONING_EFFORT` |
| `documentation-writer` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `REASONING_EFFORT` |
| `web-research` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `TAVILY_API_KEY`, `OPENAI_MODEL`, `REASONING_EFFORT` |
| `news-summarizer` | `OPENAI_API_KEY`, `NEWS_API_KEY`, `OPENAI_MODEL`, `REASONING_EFFORT` |
| `github-issue-triager` | `OPENAI_API_KEY`, `GITHUB_TOKEN`, `OPENAI_MODEL`, `REASONING_EFFORT` |
| 11 agent lain | `OPENAI_API_KEY`, `OPENAI_MODEL`, `REASONING_EFFORT` |

Kolom `secrets` berisi nama variabel saja, bukan nilainya. Nilai mengalir lewat
`context` per panggilan atau `defaultContext` di config plugin.

---

## 5. Database / External Services

Repo ini tidak punya database. Tidak ada file migrasi, seed, atau perintah init
database di file mana pun.

Layanan eksternal yang dipakai agent, bukan oleh plugin itu sendiri:

| Layanan | Dipakai agent | Base default |
|---|---|---|
| TrustBoost API | `pii-sanitization` | `https://api.trustboost.dev`, endpoint `/sanitize` (`agent.py` di checkout upstream) |
| OpenAI | 15 agent | Base URL dan model dikirim lewat context, tidak punya default di repo |
| Tavily | `web-research` | lewat nama variabel `TAVILY_API_KEY`. Pastikan variabel ini di-set di `defaultContext` plugin atau `context` per panggilan `run_agent`. Nilai harus berupa string valid. |
| News API | `news-summarizer` | lewat `NEWS_API_KEY` |
| GitHub token | `github-issue-triager` | lewat `GITHUB_TOKEN` |

Test e2e tidak memakai internet. Test itu menyalakan fixture HTTP lokal di
`127.0.0.1` dengan port ephemeral, yaitu port 0 yang dipilih sistem operasi,
sebagai pengganti API TrustBoost (`tests/e2e-pii-agent.test.ts`).

---

## 6. Running the Project

Repo ini tidak punya perintah dev server, production server, maupun port.
Tidak ada `Dockerfile`, compose, atau `Procfile`. Plugin dijalankan hanya dengan
dimuat oleh host DSH lewat profil, dijelaskan di seksi 3.

Perintah build yang tersedia:

```bash
npm run build
```

Tanda plugin berhasil dimuat host adalah tiga baris log ini, semuanya berasal
dari `src/index.ts`:

```text
[500-ai-agent] loaded 17 agents from .../agents/registry.yaml
[500-ai-agent] tool "run_agent" registered
[500-ai-agent] tool "dsh500_list_agents" registered
```

Tidak ada port atau URL untuk dibuka. Plugin tidak membuka port apa pun.

---

## 7. First Use / Quick Start

Prasyarat: plugin sudah termuat di profil, langkah 8 seksi 3 sudah berhasil.

### Langkah 1, lihat daftar agent

Dari console DSH, bukan dari shell:

```text
dsh500_list_agents()
```

Keluaran terverifikasi di host ini:

```text
Found 17 agent(s):
  - pii-sanitization (experimental): pii, security, compliance, general
  - code-review (experimental): code-review, security, general
  - documentation-writer (experimental): documentation, general
```

### Langkah 2, panggil agent secara eksplisit

```text
run_agent(agent_id: "pii-sanitization", task: "sanitize: user@example.com")
```

Keluaran ringkas di console mengikuti format render di `src/index.ts`:

```text
[success] agent="pii-sanitization" duration=2611ms
```

Nilai `duration_ms` berubah setiap run dan tidak boleh dianggap tetap.

### Langkah 3, coba routing otomatis

Tanpa `agent_id`, router membaca kata kunci di dalam task
(`CAPABILITY_KEYWORDS` di `src/router.ts`):

```text
run_agent(task: "sanitize this email address")
```

Kata `sanitize` memicu capability `pii`. Router lalu memilih agent yang
capability-nya cocok dan statusnya eligible, dengan prioritas `production`,
lalu `validated`, lalu `experimental`, lalu urutan abjad `agent_id`
(`selectAgent` di `src/router.ts`).

Tabel keyword yang dikenali, disalin dari `src/router.ts`:

| Keyword di task | Capability |
|---|---|
| `research` | `research` |
| `pii`, `sanitize`, `scrub`, `anonymize`, `data privacy` | `pii` |
| `security`, `audit` | `security` |
| `compliance` | `compliance` |
| `code-review`, `code review` | `code-review` |
| `qa` | `qa` |
| `data-analysis`, `data analysis` | `data-analysis` |
| `documentation` | `documentation` |
| `summary` | `summary` |

Kalau tidak ada keyword yang cocok, hasilnya error `NO_ELIGIBLE_AGENT`. Router
tidak punya fallback ke agent umum. Terverifikasi live di host ini:

```text
run_agent(task: "resep kue gulung tradisional untuk hari raya")
```

```text
[error] agent="" duration=0ms error="no agent matches the request capabilities"
```

### Langkah 4, panggil tanpa jaringan untuk uji aman

Panggilan berikut tidak mengirim data ke luar mana pun karena plugin memasang
`--unshare-net` ke proses agent. Berguna untuk memverifikasi rantai spawn tanpa
memakai kuota API:

```text
run_agent(agent_id: "pii-sanitization", task: "probe kontrak error", permissions_override: { network: false }, timeout_ms: 3000)
```

Keluaran terverifikasi:

```text
[success] agent="pii-sanitization" duration=2611ms
```

Status `success` di sini bukan berarti sanitasi berhasil. Agent upstream
memakai pola fail-closed: saat jaringan ditolak, ia mengembalikan JSON error
`CRITICAL` dengan konten ter-redact dan keluar dengan kode 0, sehingga bridge
melaporkannya sukses. Periksa isi `result` untuk tahu apa yang sebenarnya
terjadi.

### Bentuk hasil

Bentuk JSON yang dikembalikan bridge, dari tipe di `src/bridge.ts`:

```json
{
  "status": "success",
  "result": {},
  "artifacts": [],
  "metadata": {}
}
```

`status` berisi `success`, `error`, atau `timeout`. Field `metadata` selalu ada
dan berisi `execution_id`, `agent_id`, `agent_version`, `started_at`,
`duration_ms`, `exit_code`, `signal`, dan `tools_used`.

Satu hal yang wajib dipahami pemula. Agent Python di checkout upstream memakai
`agent_contract.py`, lewat `prepare_output()` di awal `main` dan
`finish(result, [])` di akhir. Tugas `prepare_output()` adalah memindahkan semua
print berisik, seperti banner dan progres, ke `stderr` supaya `stdout` bersih.
Hasil berbentuk dict atau list dicetak apa adanya, jadi bridge membungkusnya
sekali saja. Hasil berbentuk string masih dibungkus envelope
`{status, result, artifacts, metadata}` karena string tidak punya bentuk JSON
sendiri. Konsekuensinya: pada panggilan yang hasilnya dict, field `result` milik
respons bridge adalah dict milik agent itu sendiri, sehingga
`result.status` adalah status agent, bukan status proses. Sebelum perbaikan ini,
pembungkus menambahkan envelope kedua dengan `status` hardcoded `success` dan
menutupi status asli, itulah penyebab kegagalan e2e lama yang dibahas di seksi
10.

---

## 8. Project Structure

```text
dsh-500-ai-agent/
  package.json            manifest plugin, scripts, dependency, engines
  package-lock.json       lockfile npm
  tsconfig.json           konfigurasi TypeScript, output ke lib/
  vitest.config.ts        konfigurasi unit test, mengecualikan e2e
  vitest.e2e.config.ts    konfigurasi e2e test, hanya file e2e
  cordis.patch.yml        contoh mount plugin beserta konfigurasi
  .gitignore              daftar file yang tidak di-commit
  agent_contract.py       sumber kebenaran kontrak stdout, disalin ke tiap agent
  agents/registry.yaml    daftar 17 agent, sumber kebenaran
  src/                    kode TypeScript plugin, 9 file
  tests/                  13 file, 11 unit dan 2 e2e
  PRD.md                  kebutuhan produk
  ASSUMPTIONS.md          asumsi proyek dan koreksi terhadapnya
  BUILD_REPORT.md         laporan build, angka test di dalamnya sudah basi
  INSTALL-WEB.md          petunjuk mount ke profil web
  AGENTS.md               aturan engineering repo ini
  AUDIT_REPORT.md         audit keamanan
  CODE-REVIEW-20261006.md hasil review kode
  docs/CONTEXT-ENGINEERING.md peta konteks untuk agent yang bekerja di sini
```

Isi `src/`, jumlah baris dari `wc -l`:

| File | Baris | Fungsi | Perlu diedit pemula? |
|---|---|---|---|
| `src/index.ts` | 290 | Entry plugin, identitas, `Config`, pendaftaran dua tool | Baca dulu |
| `src/types.ts` | 135 | Tipe status, permission, capability, entri registry | Baca bila menambah capability |
| `src/registry.ts` | 279 | Baca dan validasi `agents/registry.yaml` | Baca dulu |
| `src/router.ts` | 123 | Router keyword ke capability dan pemilihan agent | Baca dulu |
| `src/permissions.ts` | 144 | Gerbang izin default-tutup | Baca dulu |
| `src/bridge.ts` | 503 | Spawn proses, timeout, validasi output | Baca dulu, paling kompleks |
| `src/runtime-manager.ts` | 147 | Siklus hidup venv per agent | Baca dulu |
| `src/runtime-backend.ts` | 266 | `buildRuntimeConfig()` untuk backend `local`, `bubblewrap`, `container` | Baca dulu |
| `src/container-runtime.ts` | 161 | Builder argv `docker` atau `podman` | Baca dulu |

Dua file yang paling duluan disentuh pemula adalah `agents/registry.yaml` untuk
menambah atau mengubah agent, dan `cordis.patch.yml` untuk mengubah konfigurasi
mount. Folder `src/` sebaiknya dibaca sampai alurnya jelas. Kalau mengubah
perilaku stdout agent, ubah `agent_contract.py` di root repo ini, lalu salin ke
17 folder agent sesuai instruksi di header file itu dan biarkan
`tests/agent-contract.test.ts` memverifikasi sinkronisasinya.

Tidak ada `CONTRIBUTING.md`, `CHANGELOG.md`, atau `NOTICE` di repo ini.

---

## 9. Common Commands

Perintah plugin, disalin verbatim dari field `scripts` di `package.json`:

| Grup | Perintah | Arti |
|---|---|---|
| Build | `npm run build` | Kompilasi TypeScript ke `lib/` |
| Build | `npm run typecheck` | Pemeriksaan tipe, perintahnya sama dengan build |
| Test | `npm test` | Menjalankan unit test |
| Test | `npm run test:e2e` | Menjalankan e2e test |
| Test | `npm run test:all` | Build, lalu unit test, lalu e2e test |

Perintah profil DSH, dari `INSTALL-WEB.md`, dijalankan di folder profil bukan
folder plugin:

| Grup | Perintah | Arti |
|---|---|---|
| Profil | `pnpm install` | Membuat symlink plugin di `node_modules` profil |

Semua perintah plugin siap disalin:

```bash
npm install
```

```bash
npm run build
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run test:all
```

---

## 10. Testing

Runner adalah `vitest` versi `^4.1.11` dari `devDependencies` di `package.json`.
Dua konfigurasi terpisah karena cakupannya berbeda. `vitest.config.ts` mencakup
`tests/**/*.test.ts` dan mengecualikan `tests/e2e-*.test.ts`, sedangkan
`vitest.e2e.config.ts` hanya mencakup `tests/e2e-*.test.ts`.

Perintahnya:

```bash
npm test
```

```bash
npm run test:e2e
```

Hasil terukur pada 2026-10-07 di host ini. Perintah `npm run test:all` keluar
dengan exit code 0. Unit test lulus 11 file dengan 132 test:

| Area | File | Jumlah lulus |
|---|---|---|
| Capability routing | `tests/router.test.ts` | 36 |
| Registry parse dan validasi | `tests/registry.test.ts` | 23 |
| Bridge lifecycle | `tests/bridge.test.ts` | 16 |
| Permission gate | `tests/permissions.test.ts` | 12 |
| Runtime backend config | `tests/runtime-backend.test.ts` | 9 |
| Secret LLM agent | `tests/llm-agents.test.ts` | 9 |
| Container runtime | `tests/container-runtime.test.ts` | 8 |
| kontrak stdout agent | `tests/agent-contract.test.ts` | 8 |
| Penolakan jaringan | `tests/network-enforcement.test.ts` | 6 |
| Fallback jaringan | `tests/network-fallback.test.ts` | 3 |
| Runtime manager venv | `tests/runtime-manager.test.ts` | 2 |
| Total unit | | 132 |

Ditambah e2e 2 dari 2 lulus di `tests/e2e-pii-agent.test.ts` dengan durasi sekitar
31 detik. Total 134 test.

Koreksi penting. `BUILD_REPORT.md` masih menulis 116 unit tambah 2 e2e sama
dengan 118. Angka itu basi. Angka yang benar adalah 134 seperti tabel di atas.

### Kontrak stdout dan file `agent_contract.py`

Setiap agent di checkout upstream meng-import `agent_contract.py`, lewat
`prepare_output()` di awal `main` dan `finish(result, [])` di akhir.
`prepare_output()` memindahkan print berisik ke `stderr` supaya `stdout` berisi
satu objek JSON saja, karena bridge mem-parse `stdout` itu sebagai output agent.

Repo ini punya `agent_contract.py` di folder root sebagai satu-satunya sumber
kebenaran. Tiap folder agent punya salinannya sendiri, dan salinan itu tidak
di-track git upstream, jadi tidak ada yang menjaga sinkronisasinya.
`tests/agent-contract.test.ts` mengunci dua hal: bentuk keluarannya, dan
kesamaan byte antara setiap salinan dengan file canonical. Kalau salinan
menyimpang, test itu gagal dan menyebut file yang menyimpang.

Dua perilaku keluarannya. Hasil berbentuk dict atau list dicetak apa adanya,
supaya bridge membungkusnya sekali saja dan `result.status` milik respons bridge
menjadi status agent yang sebenarnya. Hasil berbentuk string tetap memakai
envelope `{status, result, artifacts, metadata}`, karena string tidak punya
bentuk JSON sendiri. Sebelum diperbaiki, dict dibungkus lagi di dalam envelope
kedua dengan `status` hardcoded `success`, sehingga sanitasi yang gagal
dilaporkan sukses. Itulah penyebab kegagalan e2e lama.

Bentuk kegagalan. Unit test yang gagal tampil sebagai ringkasan `failed` dari
vitest beserta nama file dan assertion yang gagal. Kegagalan runtime tampil
sebagai JSON `status: error` atau `status: timeout` dengan `code` dari seksi 11.

---

## 11. Troubleshooting

Semua kode di bawah berasal dari `src/index.ts` untuk 6 kode validasi dan
routing, serta dari `src/bridge.ts` untuk 8 kode runtime dan output. Tidak ada
kode `RUNTIME_UNAVAILABLE` di `src/`. Kalau dokumen lama menyebutnya, itu klaim
basi.

| Kode | Gejala | Penyebab | Cara cek | Perbaikan |
|---|---|---|---|---|
| `INVALID_INPUT` | Ditolak sebelum routing | `task` kosong atau hanya spasi (`src/index.ts`) | Baca ulang task yang dikirim | Isi `task` dengan string tidak kosong |
| `AGENT_NOT_FOUND` | Ditolak saat routing | `agent_id` tidak ada di registry (`src/index.ts`) | Panggil `dsh500_list_agents()` lalu cocokkan ejaan | Pakai `agent_id` dari tabel seksi 4 |
| `NO_ELIGIBLE_AGENT` | Routing tidak menemukan agent | Task tidak mengandung keyword tabel seksi 7 (`src/router.ts`) | Uji task dengan salah satu keyword | Tambahkan keyword yang cocok, atau sebut `agent_id` eksplisit |
| `ROUTING_DISABLED` | Panggilan tanpa `agent_id` ditolak | `enableRouting: false` di config (`src/index.ts`) | Baca config plugin di `cordis.patch.yml` profil | Set `enableRouting: true`, atau selalu sertakan `agent_id` |
| `AGENT_DISABLED` | Agent ditemukan lalu ditolak | Status `registered` atau `disabled` (`src/index.ts`) | Baca field `status` entri di `agents/registry.yaml` | Pilih agent berstatus `experimental`, `validated`, atau `production` |
| `PERMISSION_DENIED` | Ditolak sebelum spawn | Meminta izin di luar yang dideklarasikan entri (`src/permissions.ts`) | Baca field `permissions` entri di `agents/registry.yaml` | Minta hanya izin yang dideklarasikan, atau ubah registry |
| `VENV_UNAVAILABLE` | Gagal sebelum spawn untuk entri ber-`venv` | venv tidak bisa dibuat atau dipakai (`src/bridge.ts`, `src/runtime-manager.ts`) | Pastikan `requirements.txt` ada di folder agent dan `python3 -m venv` bisa jalan | Perbaiki environment Python, atau hapus `venv` agar pakai `python3` sistem |
| `SANDBOX_UNAVAILABLE` | Gagal saat confinement | Provider sandbox melempar error berkode itu (`src/bridge.ts`) | Baca log host DSH | Perbaiki konfigurasi sandbox host |
| `SPAWN_FAILED` | Proses tidak bisa dibuat | Path salah atau izin OS menolak (`src/bridge.ts`) | Pastikan `root` dan `entrypoint` entri menunjuk file yang ada | Perbaiki `root` atau `entrypoint` di registry |
| `AGENT_EXIT_ERROR` | Agent keluar bukan dengan kode 0 | Error di kode Python agent, detail ada di `stderr` (`src/bridge.ts`) | Baca `details.stderr` di hasil | Perbaiki kode atau input agent |
| `MALFORMED_OUTPUT` | Stdout tidak mengandung JSON | Agent tidak mencetak JSON valid (`validateAndParseOutput` di `src/bridge.ts`) | Jalankan `agent.py` manual lalu lihat stdoutnya | Pastikan agent memakai pola `prepare_output()` dan `finish()` |
| `JSON_PARSE_ERROR` | Ada kurung kurawal tapi gagal parse | Potongan JSON di stdout rusak (`src/bridge.ts`) | Baca `details.raw` di hasil | Perbaiki output agent agar satu objek JSON utuh |
| `COLLECTION_ERROR` | Gagal membaca output | Stream output error saat pembacaan (`src/bridge.ts`) | Baca `message` di hasil dan log host | Ulangi panggilan dan cek beban host |
| `AGENT_TIMEOUT` | Status `timeout` | Agent melewati `timeout_ms` lalu bridge menghentikan proses (`src/bridge.ts`) | Bandingkan durasi dengan `resources.timeout_ms` entri | Naikkan `timeout_ms` atau sederhanakan task |

Dua masalah yang sering ditanyakan pemula. Registry tidak terbaca, dengan pesan
dari `validateEntry` di `src/registry.ts` seperti `root "..." does not exist` atau
`capabilities contains unknown value`, diperbaiki dengan membetulkan YAML-nya.
Test e2e yang gagal dulu karena pembungkus upstream, kini lulus 2 dari 2 setelah
perbaikannya, lihat seksi 10. Kalau e2e gagal di mesin Anda, itu beda masalah dan
bukan tanda instalasi npm rusak.

---

## 12. Development Guide

Repo ini tidak punya `CONTRIBUTING.md` dan tidak mendefinisikan konvensi branch,
review, atau commit di file mana pun. Aturan kerja yang ada ada di `AGENTS.md`.
Alur minimal yang didukung file adalah ubah kode, build, lalu test:

```bash
npm run build
```

```bash
npm test
```

Cara menambah agent baru, sebagai panduan berbasis aturan validasi dan bukan
klaim file:

1. Pastikan folder agent sudah ada di checkout upstream.
2. Tambah satu entri di `agents/registry.yaml` mengikuti contoh seksi 4.
3. Isi `capabilities` hanya dengan 10 tag valid dari `src/registry.ts`.
4. Isi `source` dengan repository, path, dan commit untuk provenance, aturan 7
   di `AGENTS.md`.
5. Mulai dari `status: registered`.
6. Naikkan ke `experimental` setelah panggilan pertama berhasil.
7. Naikkan ke `validated` setelah uji lengkap lulus.

Bila butuh tag capability baru, tambahkan dulu di tipe `AgentCapability` pada
`src/types.ts` dan di `VALID_CAPABILITIES` pada `src/registry.ts` sebelum dipakai
di YAML.

File `.dev/verify.sh` adalah gate milik parent dengan 8 langkah. Itu bukan perintah
newbie dan tidak perlu dijalankan rutin. Disebut di sini agar pembaca tidak
bingung saat menemukan file itu.

---

## 13. Deployment

Tidak ada path deploy di repo ini. Tidak ada `Dockerfile`, compose,
`vercel.json`, `k8s/`, `fly.toml`, `netlify.toml`, `Procfile`, `Makefile`,
`Taskfile`, maupun `justfile`. Seksi ini dipertahankan dengan satu penjelasan
agar pembaca tahu topiknya sudah dipertimbangkan.

Satu-satunya instalasi yang didukung file adalah mount plugin ke profil DSH lewat
`INSTALL-WEB.md`, dijelaskan di seksi 3. Untuk pemula itu juga opsi yang
disarankan, karena itu satu-satunya jalur yang perintahnya tertulis di file.

Variabel production diisi lewat `defaultContext` di config plugin, yang mendukung
placeholder `env:NAMA_VAR` (`src/index.ts`), atau lewat `context` per panggilan.
Gunakan bentuk `env:OPENAI_API_KEY`, jangan pernah menulis nilai asli di file
config maupun registry.

---

## 14. Security Notes

Jangan pernah commit secret asli. `.gitignore` di repo ini sudah menutup:

| Pola di `.gitignore` | Arti |
|---|---|
| `node_modules/` | Dependency npm |
| `lib/` dan `tsconfig.tsbuildinfo` | Output build, dibuat ulang dengan `npm run build` |
| `.npm-cache/` | Cache npm lokal |
| `.dev/` dan `*.log` | Artefak probe dan log |
| `tests/.tmp*/` | Fixture sementara dari test |
| `.env` dan `.env.*` | File secret, kecuali `!.env.example` |

Pola pengecualian `!.env.example` ada di `.gitignore`, tetapi tidak ada file
`.env.example` di folder plugin ini. Kalau Anda membuatnya, isi hanya dengan
placeholder.

Konfigurasi keamanan yang berlaku di sini, semuanya dibaca dari `src/`:

- Izin default-tutup. Bridge tidak pernah memberi lebih dari yang dideklarasikan
  registry (`evaluatePermission` di `src/permissions.ts`).
- Secret hanya diteruskan bila namanya tercantum di `permissions.secrets` entri
  dan nilainya ada di `context` (`buildSpawnSpec` di `src/bridge.ts`). Nilai
  secret tidak dicetak di log, hanya `agent_id`, durasi, dan exit code.
- Argumen agent dibangun sebagai array argv dan diteruskan tanpa shell, jadi
  tidak ada string command yang di-exec (`buildAgentArgs` di `src/bridge.ts`).
- `root` dinormalkan ke absolut dan path yang keluar dari workspace ditolak
  (`resolveAgentRoot` di `src/registry.ts`).
- Stdout harus mengandung JSON valid sebelum disebut sukses
  (`validateAndParseOutput` di `src/bridge.ts`).
- Builder container di `src/container-runtime.ts` membuat argv `docker` atau
  `podman` dengan `--network=none`, `--cap-drop=ALL`, rootfs read-only, dan mount
  agent read-only bila binary ditemukan. Bila tidak ditemukan, ia mengembalikan
  `argv` kosong dengan `confined: false` dan sinyal `error` eksplisit, bukan
  klaim isolasi palsu.
- Pemilihan backend tersedia lewat `buildRuntimeConfig()` di
  `src/runtime-backend.ts` dengan pilihan `local`, `bubblewrap`, dan `container`.
  Kunci config `runtimeBackend` tidak ada di `PluginConfig` pada `src/index.ts`,
  jadi cara mengaktifkannya dari config adalah **Perlu dikonfirmasi**.

Batasan yang didokumentasikan sendiri di `src/runtime-backend.ts`: `bwrap`
memblokir jaringan lewat `--unshare-net`, filesystem, dan visibilitas PID, tetapi
tidak memblokir `os.system()` atau `subprocess.call()` dari dalam Python.
Menutup celah itu butuh filter syscall atau container runtime.

Catatan lisensi. `package.json` menulis `"license": "MIT"`, tetapi tidak ada file
`LICENSE` di folder plugin ini. Itu temuan inventaris, bukan tuduhan pelanggaran.

---

## 15. FAQ

**Kenapa namanya 500 tetapi isinya 17?**
500 adalah nama katalog upstream. Yang terdaftar aktif di `agents/registry.yaml`
adalah 17 entri. Checkout upstream di host ini berisi 21 folder agent bernomor
plus satu README, terukur 22 isi pada 2026-10-07.

**Plugin ini butuh port berapa?**
Tidak butuh port. Tidak ada port di file mana pun di repo. Test e2e memakai port
ephemeral yang dipilih sistem operasi.

**Butuh database?**
Tidak, lihat seksi 5.

**Kenapa kode `RUNTIME_UNAVAILABLE` tidak ada di tabel troubleshooting?**
Karena string itu tidak ada di `src/`. Itu klaim basi dari dokumen lama. Daftar 14
kode yang benar ada di seksi 11.

**Unit test lulus tetapi e2e gagal, apakah instalasi saya rusak?**
Tidak. Kondisi terukur 2026-10-07 setelah perbaikan pembungkus: 132 unit test
lulus, e2e lulus 2 dari 2. Kegagalan e2e sebelumnya berasal dari pembungkus yang
menulis `status` hardcoded `success`, bukan dari instalasi. Lihat seksi 10.

**Panggilan agent keluar dengan `Process exited with code 1` dan
`ModuleNotFoundError`, kenapa?**
Venv agent itu belum terisi. `runtime-manager.ts` membangun venv dari
`requirements.txt` tiap agent, dan kalau sebuah pin dependency sudah tidak ada
di PyPI, `pip install` gagal lalu venv dibuang. Pada 2026-10-07 itu terjadi di
`web-research`, karena `langchain-tavily==0.1.0` di `requirements.txt`-nya sudah
tidak ada, versi terdekat yang tersedia mulai 0.1.5. Perbaikannya ada di
`requirements.txt` agent tersebut di checkout upstream, jadi itu keputusan
pemilik checkout, bukan isi repo plugin ini.

**Registry minta Python 3.11 tetapi host saya 3.14, bagaimana?**
Itu kondisi nyata di host ini. Tiga entri ber-`venv` membangun environment
sendiri lewat `src/runtime-manager.ts`. Empat belas entri lain memakai `python3`
sistem. Apakah semua agent berjalan benar di 3.14 adalah **Perlu dikonfirmasi**.

**Bagaimana memanggil `recipe-agent` yang capability-nya hanya `general`?**
Tidak ada keyword yang memetakan ke `general` di `src/router.ts`, jadi agent itu
tidak terjangkau oleh routing otomatis. Panggil dengan `agent_id` eksplisit dari
console DSH:

```text
run_agent(agent_id: "recipe-agent", task: "resep nasi goreng")
```

**Bolehkah menulis kunci API di `agents/registry.yaml` agar praktis?**
Tidak. Registry hanya berisi nama secret, sedangkan nilainya mengalir lewat
`context` atau `defaultContext`. Lihat seksi 4 dan 14.

**Apa arti `logLevel` di luar `info`, `warn`, `error`?**
Skema menerima string apa pun, sedangkan helper log memakai tiga level itu.
Perilaku nilai lain adalah **Perlu dikonfirmasi**.

---

## 16. Final Checklist

- [ ] Node.js `>=20` dan npm terpasang, dicek dengan `node --version` dan `npm --version`
- [ ] `python3` tersedia, dicek dengan `python3 --version`
- [ ] Checkout katalog upstream ada di path yang ditunjuk field `root`
- [ ] `npm install` dijalankan di folder plugin
- [ ] `npm run build` dijalankan dan menghasilkan `lib/index.js`
- [ ] Dependency dan bundle ditambahkan ke `package.json` profil web
- [ ] Baris config ditambahkan ke `cordis.patch.yml` profil web
- [ ] `pnpm install` dijalankan di folder profil web
- [ ] DSH di-restart oleh operator
- [ ] `dsh500_list_agents()` mengembalikan 17 agent
- [ ] `run_agent` dengan `agent_id` eksplisit berhasil dipanggil
- [ ] Routing otomatis dicoba dan batas keyword-nya dipahami
- [ ] Tidak ada secret asli di file mana pun

---

## Dokumen pendukung

| Dokumen | Isi |
|---|---|
| [`PRD.md`](PRD.md) | Kebutuhan produk, tujuan, dan batasan |
| [`ASSUMPTIONS.md`](ASSUMPTIONS.md) | Asumsi proyek dan koreksi terhadapnya |
| [`BUILD_REPORT.md`](BUILD_REPORT.md) | Laporan build, **angka test di dalamnya sudah basi** |
| [`INSTALL-WEB.md`](INSTALL-WEB.md) | Petunjuk mount ke profil web |
| [`AGENTS.md`](AGENTS.md) | Aturan engineering repo ini |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | Audit keamanan |
| [`CODE-REVIEW-20261006.md`](CODE-REVIEW-20261006.md) | Hasil review kode |
| [`agents/registry.yaml`](agents/registry.yaml) | Daftar agent, sumber kebenaran |
| [`docs/CONTEXT-ENGINEERING.md`](docs/CONTEXT-ENGINEERING.md) | Peta konteks untuk agent yang bekerja di sini |