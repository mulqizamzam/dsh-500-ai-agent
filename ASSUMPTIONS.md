# ASSUMPTIONS

## Project

Integrasi `ashishpatel26/500-AI-Agents-Projects` sebagai capability/plugin layer untuk DeepSeek Harness (DSH).

## Status

Draft arsitektur dan implementation baseline. Dokumen ini tidak menyatakan bahwa integrasi end-to-end telah berhasil dijalankan.

## Assumptions

1. DSH diperlakukan sebagai control plane/orchestrator dan tetap menjadi source of lifecycle, session, tool, model, dan policy orchestration.
2. Repository 500-AI-Agents diperlakukan sebagai katalog implementation/capability, bukan dependency monolith.
3. Agent dari katalog dapat memiliki runtime dan dependency berbeda; dependency tidak digabung ke runtime DSH.
4. Python agent merupakan target runtime awal karena banyak proyek pada katalog menggunakan Python.
5. Integrasi dilakukan melalui adapter/bridge yang memiliki kontrak input/output terstandar.
6. Agent Registry menjadi source of truth untuk agent yang telah diimpor/diaktifkan.
7. Capability routing memilih agent berdasarkan capability metadata, permission compatibility, health, dan runtime availability; bukan berdasarkan nomor folder.
8. Agent dijalankan secara lazy/on-demand.
9. Prototype dapat menggunakan subprocess + isolated virtual environment; deployment production diarahkan ke container/sandbox.
10. Permission default adalah deny-by-default untuk network, filesystem, shell, dan secrets.
11. Agent yang belum divalidasi boleh berada di katalog tetapi tidak otomatis eligible untuk production routing.
12. DSH API dapat berubah karena status developer preview; adapter harus meminimalkan ketergantungan pada internal implementation.
13. Setiap agent harus mempertahankan provenance: repository, path, version/commit, runtime, dan dependency lock/pinning jika tersedia.
14. Observability minimal mencakup agent ID/version, execution status, duration, tool usage, error, dan resource/cost metadata jika tersedia.
15. Human approval diperlukan untuk capability yang memiliki konsekuensi eksternal atau berisiko tinggi.
16. Lisensi, API terms, model terms, dan credential requirements setiap agent harus diperiksa sebelum distribusi.
17. Target awal adalah membuktikan satu agent end-to-end sebelum memperluas katalog.

## Non-assumptions

Hal-hal berikut belum dianggap terbukti:

- seluruh 500+ agent kompatibel dengan DSH;
- seluruh proyek memiliki kualitas production-grade;
- semua dependency dapat di-install tanpa perubahan;
- semua agent memiliki interface yang seragam;
- semua agent aman dijalankan dengan permission yang sama;
- DSH API akan tetap stabil;
- performa atau reliability target telah tercapai.

## Decision Rule

Jika fakta implementasi aktual bertentangan dengan asumsi di atas, fakta source code dan hasil pengujian mengalahkan dokumen ini. Assumption harus diperbarui, bukan dipaksakan.

## Asumsi Fase 2 (Hardening) — Fakta Baru

1. **DSH `ctx.sandbox` tersedia di profil web** — `@deepseek-ai/dsh-sandbox` + `@deepseek-ai/dsh-sandbox-local` ter-inject melalui bundle `dsh-base`. Plugin bisa pakai `ctx.sandbox.confine(argv, policy)`.
2. **`bwrap --unshare-net` benar-benar memblokir jaringan** — diuji empiris: socket connect ke 1.1.1.1:443 gagal dengan `OSError`, bukan timeout. Ini bukan klaim env-var scrubbing.
3. **`bwrap` tidak bisa memblokir exec dari dalam Python** — tidak ada flag `--deny-exec` atau seccomp filter di bwrap. Shell boundary perlu remediation terpisah (Landlock / Container).
4. **Host mount `/` RO** — hanya workspace rw. `$DSH_HOME/profiles/web/` di luar batas tulis. `--dump-config` gagal EROFS di profile asli; solusinya DSH_HOME override ke path writable.
5. **Tool name collision `list_agents`** — host DSH punya `@deepseek-ai/dsh-tool-subagent-control/list-agents` yang sudah register tool `list_agents`. Plugin menggunakan `dsh500_list_agents` sebagai workaround.
6. **`Config` harus schemastery Schema** — bukan plain object. `resolveConfig()` memanggil `runtime.Config['~standard'].validate(config)`; plain object undefined → crash.
7. **Plugin node_modules sendiri** — DSH tidak pakai `--preserve-symlinks`, jadi plugin wajib punya `node_modules/` sendiri dengan dependency pin exact.
8. **Web profile l3-rendezvous blocking** — service persistent menjalankan background loop yang menahan proses headless. Satu-satunya solusi: buat DSH profile custom tanpa l3-rendezvous (bukan web).

## Asumsi yang Terbukti SALAH (koreksi implementasi)

1. **Katalog 500 agent.** Catalog lokal hanya berisi 21 agent (01..21 + README);
   tidak ada yang otomatis "500". Jumlah agent nyata harus dihitung dari
   `ls agents/`, bukan dari nama repo.
2. **DSH tidak punya service subprocess.** Fakta: `ctx.subprocess.spawn(spec)`
   tersedia sebagai service host (`@deepseek-ai/dsh-subprocess`), sudah
   meng-scrub kredensial dan DSH_* dari parent env, dan melakukan
   terminate tree-scoped. Bridge langsung memakai seam ini; tidak ada subprocess
   manager buatan plugin.
3. **Registry root relatif ke CWD host.** Fakta: `root` di registry
   dinormalisasi terhadap direktori file registry saat parse; bridge memakai
   path absolut tersebut.
4. **`entrypoint_args` string shell.** Fakta: argv array template; nilai
   resolver diteruskan ke execve apa adanya, tidak pernah di-shell.
5. **Timeout cukup pakai timer + kill di caller.** Fakta: `AbortSignal`
   harus dipasang di spawn spec; timer caller saja tidak menghentikan proses
   child. Terminate bridge memakai `handle.terminate()`.
6. **External plugin bisa pakai node_modules host.** Fakta: plugin di luar
   monorepo perlu `node_modules` sendiri; `@deepseek-ai/dsh-tools` dan
   `@deepseek-ai/dsh-subprocess` di-pin exact version (`0.1.2-rc.1`).
7. **`defineTool` tanpa schema strict.** Fakta: `dsh-tools` rc.8 mewajibkan
   `additionalProperties` eksplisit di setiap object schema, dan
   `output.schema` menghasilkan inferensi return type yang ketat; pakai
   `{ type: 'json' }` bila tidak mau mengunci shape.


## Asumsi Fase 3 (Live Integration) — Fakta Baru

9. **Root mount `/` read-only, catalog 500-AI-Agents ikut RO.** `ensureVenv`
   yang menulis `<agentRoot>/.dsh500-venv` GAGAL EROFS. Runtime-manager
   kini probe writability dan jatuh ke `<workspaceRoot>/venvs/<agentId>/`.
   Isolasi per-agent tetap terjaga (venv dikey per agentId).
10. **Profile `web` adalah surface berbasis browser, bukan one-shot CLI.**
    Posisi argumen task ditolak oleh commander adapter `playwright-core`
    (`Expected 0 arguments but got 1`) — ini contract surface, bukan bug DSH
    dan bukan bug plugin. One-shot text task termasuk ke surface headless
    (`dsh --profile headless "task"`).
11. **l3-rendezvous consumer menahan proses** — empat percobaan run
    berakhir EXIT=124 (timeout) atau EXIT=1 (arg rejection). Semua tercatat,
    tidak ada yang dilaporkan sebagai PASS.
12. **Secret gating model: registry-declared allowlist.** Jika request tidak
    menyebut `secrets`, bridge meneruskan SEMUA secret yang dideklarasikan
    registry (granted = declared set). Jika request menyebut, set itu wajib
    subset dari declared. Ditolak jika ada nama di luar declared.
13. **`list_agents` nama tabrakan dengan host** — `dsh-subagent-control`
    sudah memakai `list_agents`. Plugin memakai `dsh500_list_agents`.

## Koreksi 2026-10-11 (terukur ulang, mengalahkan asumsi lama)

1. **Katalog upstream kini WRITABLE** — `touch` probe di `/home/administrator/agent-workspace/project/500-AI-Agents-Projects/agents/21-pii-sanitization-agent/` berhasil (file probe langsung dihapus). Asumsi Fase 3 #9 (root mount RO, `ensureVenv` EROFS) tidak lagi berlaku; lokasi fallback `<workspaceRoot>/venvs/<agentId>` tetap ada sebagai jaring pengaman dan sudah teruji.
2. **`docker` di PATH bukan runtime yang berfungsi** — shim WSL Docker Desktop, `docker --version` exit 1 di distro ini. Backend `container` karena itu mengembalikan sinyal `error` (fail-closed), bukan run. Klaim BUILD_REPORT "Docker 29.8.1 available" adalah keadaan 2026-10-04, bukan hari ini.
3. **`ensurepip` tidak tersedia, pip sistem tersedia** — `/usr/bin/python3.14` tidak punya modul `ensurepip`; `python3 -m venv` gagal exit 1 sementara `python3 -m pip` 26.2.1 berfungsi. `ensureVenv` kini fallback ke `python3 -m venv --without-pip` + `python3 -m pip --python <venv>/bin/python install -r requirements.txt` (isolasi per-agent tetap: paket masuk ke site-packages venv tersebut).
4. **Default filesystem kini benar-benar default-deny** — dulu bridge selalu memakai policy `workspace-write`/`--bind` sehingga setiap agent bisa menulis root-nya sendiri walau `filesystem: null`. Sekarang grant `null`/`read`/`none` → bind read-only; hanya `readwrite` (opt-in eksplisit di registry; 3 agent: meeting-notes, unit-test-generator, documentation-writer) → bind rw.
5. **Injeksi `--unshare-net` kini tunggal implementasi** (`src/network-denial.ts`) — sebelumnya logikanya diduplikasi di `bridge.ts` dan `runtime-backend.ts`; fix DEFECT 1 hanya masuk ke `bridge.ts`, dan bentuk runner non-bwrap (Landlock/Seatbelt) dilaporkan sebagai `enforcement: partial` alih-alih diverifikasi.
