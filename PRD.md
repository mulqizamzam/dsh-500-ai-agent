# PRD — DSH 500+ AI Agents Plugin Platform

## 1. Product

**Nama kerja:** DSH Agent Catalog Bridge

**Tujuan:** menjadikan `ashishpatel26/500-AI-Agents-Projects` sebagai sumber capability agent yang dapat di-discover dan dipanggil oleh DeepSeek Harness melalui plugin/adapter layer.

## 2. Vision

DSH menjadi control plane. Katalog 500+ agent menjadi capability inventory.

```text
User
  |
  v
DeepSeek Harness
  |
  v
Capability Router
  |
  v
Agent Registry
  |
  v
Agent Bridge
  |
  +--> Research runtime
  +--> RAG runtime
  +--> Coding runtime
  +--> Other validated runtimes
```

## 3. Problem

Katalog agent dan DSH menggunakan lifecycle, runtime, dependency, dan interface yang berbeda. Integrasi langsung akan menciptakan dependency conflict, permission sprawl, dan coupling terhadap implementation detail.

Produk ini menyelesaikan masalah tersebut melalui contract, registry, bridge, isolation, routing, dan observability.

## 4. Goals

### G1 — Standard invocation

Semua agent yang terdaftar dapat dipanggil melalui kontrak standar.

### G2 — Isolation

Dependency dan failure agent tidak menyebar ke DSH atau agent lain.

### G3 — Discoverability

DSH dapat menemukan agent berdasarkan capability metadata.

### G4 — Security

Permission network/filesystem/shell/secrets explicit dan deny-by-default.

### G5 — Lifecycle

Start, execute, timeout, terminate, retry, cleanup.

### G6 — Observability

Setiap invocation dapat diaudit.

### G7 — Scalability

Menambah agent tidak memerlukan perubahan core DSH.

## 5. Non-Goals

- menggabungkan 500 agent menjadi satu Python environment;
- mengonversi semua agent menjadi TypeScript;
- menjalankan seluruh agent secara bersamaan;
- fork permanen DSH core;
- menyatakan semua proyek production-grade.

## 6. Users

### Primary

Developer/operator DSH yang ingin memperluas capability agent.

### Secondary

AI agent yang membutuhkan specialist capability.

### Tertiary

Maintainer yang menambahkan agent baru ke catalog.

## 7. Core Workflow

```text
request
  -> capability detection
  -> registry lookup
  -> policy filtering
  -> runtime selection
  -> isolated execution
  -> output validation
  -> result
  -> telemetry
```

## 8. Functional Requirements

### FR-01 Registry

Registry menyimpan:

- id;
- name;
- version;
- runtime;
- entrypoint;
- capabilities;
- permissions;
- resource limits;
- source/provenance;
- maturity/status.

### FR-02 Invocation

Input:

```json
{
  "agent_id": "web-research",
  "task": "research task",
  "context": {},
  "timeout_ms": 120000
}
```

Output:

```json
{
  "status": "success",
  "result": {},
  "artifacts": [],
  "metadata": {}
}
```

### FR-03 Lifecycle

Bridge wajib menangani:

```text
discover
validate
start
execute
timeout
terminate
collect
cleanup
```

### FR-04 Routing

Router memilih agent berdasarkan capability dan policy.

### FR-05 Isolation

Runtime agent terpisah dari runtime DSH.

### FR-06 Permissions

Permission dapat dibatasi per agent.

### FR-07 Validation

Output harus memenuhi schema sebelum dikembalikan sebagai successful result.

### FR-08 Observability

Execution harus memiliki execution ID dan status.

## 9. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Reliability | failure agent terisolasi |
| Security | deny-by-default |
| Extensibility | tidak perlu mengubah core untuk menambah agent |
| Reproducibility | runtime/dependency dapat dipin |
| Performance | lazy loading |
| Debuggability | structured logs |
| Portability | agent runtime tidak bergantung pada DSH internals |

## 10. Proposed Architecture

```text
+--------------------------------------------------+
|                  DeepSeek Harness                |
|                                                  |
|  Agent Loop / LLM / Tools / Session / Policy    |
|                      |                           |
|              +-------v--------+                  |
|              | Capability      |                  |
|              | Router          |                  |
|              +-------+--------+                  |
|                      |                           |
|              +-------v--------+                  |
|              | Agent Registry |                  |
|              +-------+--------+                  |
|                      |                           |
|              +-------v--------+                  |
|              | Agent Bridge   |                  |
|              +-------+--------+                  |
+----------------------|---------------------------+
                       |
                isolated runtime
          +------------+------------+
          |            |            |
       Research       RAG         Coding
```

## 11. Runtime Strategy

### Phase 1

Subprocess + per-agent virtual environment.

### Phase 2

Containerized runtime.

### Phase 3

Managed sandbox/runtime pool.

## 12. Security

Default deny:

```yaml
network: false
filesystem: none
shell: false
secrets: none
```

Permission escalation harus eksplisit, terdokumentasi, dan diuji.

## 13. Maturity Model

```text
registered
  -> experimental
  -> validated
  -> production
```

Agent gagal validation harus dapat dinonaktifkan tanpa menghapus registry history.

## 14. Rollout

### Phase 0 — Audit

Audit DSH plugin API dan reference agent.

### Phase 1 — Bridge

Implementasikan registry + bridge + one reference agent.

### Phase 2 — Hardening

Timeout, crash isolation, permissions, output validation.

### Phase 3 — Routing

Capability router dan health-aware selection.

### Phase 4 — Expansion

3–5 agents.

### Phase 5 — Scale

10 -> 50 -> 100 -> 500+.

## 15. Acceptance Criteria

1. Plugin dapat dimuat oleh DSH.
2. Registry dapat dibaca.
3. Minimal satu agent katalog berjalan end-to-end.
4. Dependency agent tidak masuk ke runtime DSH.
5. Timeout dapat menghentikan execution.
6. Crash agent tidak menjatuhkan DSH.
7. Permission policy diterapkan.
8. Output invalid ditolak.
9. Invocation dapat diobservasi.
10. Agent baru dapat ditambahkan melalui registry tanpa modifikasi core.

## 16. Risks

- DSH API berubah.
- Dependency agent tidak reproducible.
- Agent kualitas tidak seragam.
- Credential/secrets leakage.
- Network/filesystem abuse.
- Latency dan biaya meningkat pada multi-agent routing.

## 17. Success Metrics

Target awal:

- 1 reference agent berhasil end-to-end;
- >=95% successful invocation pada validation suite;
- 100% crash containment;
- 0 unauthorized capability access;
- agent onboarding melalui registry <=30 menit setelah adapter tersedia.

Angka tersebut adalah target, bukan hasil pengukuran saat ini.
