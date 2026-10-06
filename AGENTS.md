# AGENTS.md

## Purpose

Panduan untuk AI coding agents dan developer yang mengerjakan integrasi 500-AI-Agents dengan DeepSeek Harness.

## Repository Boundary

Jangan mengubah DSH core hanya untuk mengakomodasi agent catalog jika extension/plugin API sudah cukup.

Gunakan:

```text
DSH
  -> Plugin
     -> Agent Registry
        -> Agent Bridge
           -> Isolated Agent Runtime
```

## Required Reading Order

1. `PRD.md`
2. `ASSUMPTIONS.md`
3. `BUILD_REPORT.md`
4. source DSH/plugin API yang sedang digunakan
5. source agent yang sedang diintegrasikan

## Engineering Rules

### 1. Jangan menggabungkan dependency

Jangan melakukan:

```text
pip install requirements.txt dari semua agent
```

ke satu environment DSH.

Setiap agent mempertahankan runtime/dependency isolation.

### 2. Gunakan contract standar

Request minimum:

```json
{
  "agent_id": "string",
  "task": "string",
  "context": {},
  "timeout_ms": 120000
}
```

Response minimum:

```json
{
  "status": "success|error|timeout",
  "result": null,
  "artifacts": [],
  "error": null,
  "metadata": {}
}
```

### 3. Registry-driven

Jangan hard-code daftar 500 agent di router.

Agent harus ditemukan melalui registry dan metadata.

### 4. Capability-first routing

Gunakan:

```text
capability -> eligible agents -> policy filter -> selected agent
```

bukan:

```text
folder number -> agent
```

### 5. Security

Default:

```text
network: false
filesystem: none
shell: false
secrets: none
```

Permission tambahan harus eksplisit dan sesempit mungkin.

### 6. Isolation

Prototype:

```text
subprocess + venv
```

Production:

```text
container/sandbox
```

Agent crash, timeout, atau dependency failure tidak boleh menjatuhkan DSH.

### 7. Provenance

Setiap agent registry entry harus menyimpan source repository/path dan version/commit jika tersedia.

### 8. Validation

Agent baru tidak boleh otomatis berstatus production-ready.

Gunakan status seperti:

```text
experimental
validated
production
disabled
```

### 9. Observability

Setiap invocation harus dapat dilacak minimal berdasarkan:

```text
agent_id
agent_version
execution_id
status
duration
error
```

Tambahkan token/cost/tool telemetry jika tersedia.

### 10. Tests

Setiap adapter wajib memiliki:

- registry validation test;
- invocation test;
- timeout test;
- malformed-output test;
- process-crash test;
- permission test;
- cleanup test.

## Change Discipline

- Perubahan kecil dan terisolasi.
- Jangan melakukan mass refactor DSH.
- Jangan menghapus capability native DSH tanpa bukti bahwa adapter menggantikannya.
- Jangan menyatakan build berhasil tanpa menjalankan build/test yang relevan.
- Jangan menyatakan agent kompatibel sebelum invocation nyata berhasil.

## Commit/PR Expectations

Setiap perubahan harus menjawab:

1. capability apa yang ditambahkan?
2. agent/runtime apa yang dipengaruhi?
3. permission apa yang berubah?
4. dependency apa yang berubah?
5. bagaimana pengujiannya?
6. apa failure mode baru?

## Completion Definition

Pekerjaan dianggap selesai hanya jika:

- source dapat dibuild;
- plugin dapat dimuat;
- registry dapat dibaca;
- reference agent dapat dipanggil;
- timeout/crash ditangani;
- hasil tervalidasi;
- test relevan lulus;
- dokumentasi instalasi tersedia.
