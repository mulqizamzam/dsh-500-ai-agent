# Install 500-AI-Agent Plugin into DSH Web Profile

## Why this is needed

The plugin source and tests are complete. Live tool invocation requires wiring
the plugin into the running `web` profile (`$DSH_HOME/profiles/web`).
Writes to that directory land on the read-only root mount (EROFS) and are
outside the current session sandbox, so they must be done by the operator.

## Three changes to make

### 1. Add dependency to `$DSH_HOME/profiles/web/package.json`

In `"dependencies"`, insert:

```json
"dsh-500-ai-agent": "link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-500-ai-agent"
```

### 2. Add bundle to `$DSH_HOME/profiles/web/package.json`

In `"dsh.profile.bundles"`, append `"dsh-500-ai-agent"`.

### 3. Add config row to `$DSH_HOME/profiles/web/cordis.patch.yml`

Append:

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

## Then run

```bash
cd "$DSH_HOME/profiles/web"
pnpm install
```

This creates `node_modules/dsh-500-ai-agent → <plugin_dir>` symlink.

## Verify

Setelah `pnpm install` dan restart, dari sesi baru:

```bash
# 1. Plugin terdaftar di komposisi
DSH_HOME="$DSH_HOME" node --import tsx/esm \
  /home/administrator/deepseek-harness/apps/cli/src/bin.ts \
  --profile web --dump-config | grep -c "500-ai"
```
Expected: `5` (id, name, registryPath, workspaceRoot, enableRouting).

```bash
# 2. Tool terdaftar — cek daftar tool via UI console, bukan CLI
```
`dsh500_list_agents` dan `run_agent` dipanggil dari **DSH web UI console**.
Satu-shot `dsh --profile web "task"` tidak bisa dipakai: commander
`playwright-core` di surface web menolak argumen posisional
(`Expected 0 arguments but got 1`). Detail dan bukti di `BUILD_REPORT.md`.

## Restart DSH

Run `/home/administrator/restart-dsh.sh` (or your DSH restart procedure) so
the updated composition is picked up.

## Blocker note

After install, live `dsh500_list_agents` still hits the web-surface arg
rejection documented in BUILD_REPORT.md (`playwright-core` commander:
`Expected 0 arguments but got 1`). Use the DSH web UI console to invoke
`dsh500_list_agents` directly (UI calls are not one-shot task commands), or
switch to the headless profile for CLI-driven agent runs.
