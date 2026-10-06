# Context Engineering — dsh-500-ai-agent

Dokumen ini menjelaskan konteks yang perlu dimuat agar agent (manusia atau AI)
bisa bekerja di repo ini tanpa salah mengira. Ini melengkapi `AGENTS.md`
(aturan kerja), `PRD.md` (visi), dan `README.md` (cara pakai tool).

Sumber facts di dokumen ini: `src/index.ts`, `src/bridge.ts`, `src/router.ts`,
`src/permissions.ts`, `agents/registry.yaml`, dan `README.md`, dibaca langsung
pada 2026-10-06. Angka dan status di bawah bukan estimasi.

---

## 1. Apa repo ini dalam satu kalimat

Plugin DSH yang mengekspos agent dari repo upstream
`ashishpatel26/500-AI-Agents-Projects` sebagai dua tool host
(`dsh500_list_agents` dan `run_agent`), dengan registry sebagai sumber
kebenaran, permission default-deny, dan runtime terisolasi per agent.

Yang perlu tidak disalahpahami: namanya "500 AI Agents" tapi katalog lokal
hanya berisi **17 agent terdaftar** (21 file agent di disk, 17 di registry).
Angka 17 berasal dari parse `agents/registry.yaml`, bukan asumsi.

---

## 2. Peta repo — baca hanya yang relevan

| Path | Isi | Kapan baca |
|---|---|---|
| `src/index.ts` | Cordis plugin: config schema, dua tool, routing + permission gate | mengubah kontrak tool |
| `src/registry.ts` | Parse + validasi `registry.yaml` | menambah agent / ubah schema |
| `src/router.ts` | Keyword → capability → agent terpilih | task routing tidak cocok |
| `src/permissions.ts` | Evaluasi permission request vs deklarasi agent | `PERMISSION_DENIED` muncul |
| `src/bridge.ts` | Spawn subprocess, timeout, abort, output validation | agent timeout/crash/output rusak |
| `src/container-runtime.ts` | Stub backend container (`argv: []`) | backend isolation |
| `agents/registry.yaml` | Source of truth: 17 entri agent | sebelum memanggil `run_agent` |
| `tests/` | 116 unit + 2 e2e (vitest) | sebelum menyatakan selesai |

Jangan baca semuanya. Untuk task "panggil agent X", cukup
`agents/registry.yaml` + bagian "Cara pakai" di `README.md`.

---

## 3. Rantai pemanggilan — siapa memanggil siapa

```
User (chat)
  → Model AI (saya)          ← plead: tool-call dikirim dari sini, bukan user langsung
  → DSH host (agent-loop)    ← tool registry mencocokkan nama tool
  → plugin execute()          ← cek status agent, evaluasi permission
  → bridge.runAgent()         ← ctx.subprocess.spawn + bwrap
  → proses Python agent.py    ← argv dari entrypoint_args, tanpa shell
```

Konsekuensi untuk agent yang bekerja di sini: perubahan yang menyentuh
`src/index.ts` mengubah perilaku tool yang sedang dipakai percakapan ini, jadi
verify lewat tool call, bukan hanya unit test.

---

## 4. Kontrak dua tool

### `dsh500_list_agents`

Tidak menerima parameter. `execute()` memetakan registry jadi array objek:
`agent_id`, `name`, `status`, `capabilities`, `runtime`, `permissions`.
Prefix `dsh500_` dipakai karena host sudah punya tool `list_agents` dari
`dsh-subagent-control` — nama itu bentrok kalau tidak diprefix.

### `run_agent`

Parameter: `agent_id` (opsional), `task` (wajib), `context` (opsional),
`timeout_ms` (opsional), `permissions_override` (opsional).
Urutan gate di `execute()`:

1. `task` non-kosong, kalau tidak → `INVALID_INPUT`
2. agent ditemukan di registry, kalau tidak → `AGENT_NOT_FOUND`
3. routing bila `agent_id` absen, tidak ada kandidat → `NO_ELIGIBLE_AGENT`
4. status bukan `disabled`/`registered`, kalau tidak → `AGENT_DISABLED`
5. permission vs deklarasi, kalau tidak → `PERMISSION_DENIED`
6. baru spawn

Knowing urutan ini menghemat waktu: pesan error memberitahu tahap mana gagal.

---

## 5. Permission — default deny, dan itu bukan slogan

`permissions.yaml` tiap agent mendeklarasikan maksimum yang boleh diminta.
`permissions_override` hanya bisa **mempersempit**, tidak bisa menambah. Kalau
saya minta `filesystem: read` untuk agent yang deklarasinya `null`, hasilnya
`PERMISSION_DENIED`, bukan diam-diam diabaikan.

Nilai yang terukur di 17 entri saat ini:

| Leaf | Nilai di registry |
|---|---|
| `network` | `true` untuk semua 17 |
| `shell` | `false` untuk semua 17 |
| `filesystem` | `null` untuk semua 17 |
| `secrets` | 16 agent pakai `OPENAI_API_KEY`; `pii-sanitization` justru `TRUSTBOOST_API_BASE` |

`network: true` di semua agent bukan-meaningless: registry hanya mendeklarasikan
izin maksimum, runtime tidakwala akses. Yang benar-benar membatasi ada di
`bwrap --unshare-net` dan scrubbing env — lihat bagian batasan di bawah.

---

## 6. Routing — substring match, bukan semantic

`src/router.ts` mencocokkan **keyword lowercase** di dalam teks task ke
capability. Konsekuensi yang harus diingat:

- Task berbahasa Indonesia tanpa keyword Inggris → `NO_ELIGIBLE_AGENT`.
  Contoh: "buatkan ringkasan" tidak mengandung `summary`, tapi
  "summarize this" mengandung.
- Tidak ada fallback ke agent "general" meski semua agent punya capability
  `general`. Ini invariant yang disengaja.
- Solusi untuk task yang gagal routing: pola 2 (`agent_id` eksplisit).

---

## 7. Batasan yang harus disebut, bukan disembunyikan

Terukur dan tertulis di `README.md` § Known limitations:

| Batasan | Bukti |
|---|---|
| Shell boundary belum ada — `bwrap` tidak memblokir `os.system()` di dalam Python | tidak ada `--deny-exec`/seccomp di bwrap |
| `ContainerRuntime` masih stub | `src/container-runtime.ts` mengembalikan `argv: []` |
| 16 dari 17 agent belum teruji end-to-end | butuh `OPENAI_API_KEY` + jaringan keluar |
| Agent 03, 04, 08, 13 tidak bisa dijalankan | memakai `input()` interaktif |
| Katalog lokal 21 file, bukan 500 | registry berisi 17 entri |

Yang terverifikasi live (bukan dari dokumen): `dsh500_list_agents` mengembalikan
17 agent dan `run_agent` terdaftar sebagai tool host. Yang **tidak** terverifikasi:
`run_agent` yang benar-benar memanggil agent Python sampai selesai di sesi ini.

Kalau butuh statement "sudah jalan", itu harus datang dari pemanggilan nyata,
bukan dari registry yang terbaca.

---

## 8. Session boundary untuk agent yang mengerjakan repo ini

Kalau sesi perlu di-restart,persist sebelum keluar:

1. status task dan file yang berubah (`git status` di `dsh-custom/plugins/dsh-500-ai-agent`)
2. perintah verifikasi yang dipakai beserta exit code asli
3. pertanyaan yang menggantung (mis. credential agent mana yang boleh dipakai)
4. keputusan yang sudah diambil tapi belum tertulis di `README.md`

Restart script `/home/administrator/restart-dsh.sh` milik owner — agent tidak
menjalankannya sendiri. Verifikasi tool cukup lewat pemanggilan tool, tidak
perlu restart.

---

## 9. Verification checklist

Sebelum menyatakan selesai:

- [ ] `npm test` benar-benar dijalankan, exit code原文 direkam
- [ ] `npm run test:e2e` dijalankan kalau menyentuh bridge/registry
- [ ] perubahan tool diverifikasi lewat tool call, bukan asumsi
- [ ] batasan baru ditulis di `README.md` § Known limitations
- [ ] tidak ada angka di dokumen yang belum berasal dari eksekusi terukur

---

## 10. Konvensi penulisan

Tidak ada em dash. Angka selalu dari eksekusi terukur; yang belum diukur ditulis
"belum ditentukan" beserta asumsinya, bukan diisi perkiraan. Klaim "by design"
harus dirujuk ke kontrak tertulis — kalau tidak ada di dokumen, itu label
cacat desain, bukan pembenaran.