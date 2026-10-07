"""
DSH 500-AI-Agent contract helper (canonical copy).

Each agent.py in 500-AI-Agents-Projects prints human-oriented text (banners,
progress markers, demo headers) to stdout, while the DSH bridge treats stdout
as the agent's output and expects exactly one valid JSON object there. This
module gives every agent two helpers that, called at the top and bottom of
``main()``, keep the noise out of stdout and put one JSON object in it.

This file is the single source of truth for that behaviour. The agent trees in
the upstream checkout carry their own copy per agent folder; those copies are
NOT tracked by the upstream repo, so nothing keeps them in sync with this one.
After changing this file, copy it into every agent folder that imports it:

    for d in <upstream>/agents/*/; do
      [ -f "$d/agent_contract.py" ] && cp agent_contract.py "$d/agent_contract.py"
    done

Usage in agent.py (minimal pattern)::

    from agent_contract import prepare_output, finish
    import sys

    def main():
        prepare_output()
        # ... all existing print() calls stay as-is (they now go to stderr) ...
        result = your_work(args)
        artifacts = []
        try:
            finish(result, artifacts)
        except SystemExit as exc:
            sys.exit(exc.code)

Rules:
- ``prepare_output()`` must be the FIRST line in main() (after imports).
- ``finish(result, artifacts)`` must be the LAST line before main() returns.
- Existing ``print(...)`` calls MUST remain unchanged; ``prepare_output()``
  redirects them to stderr automatically.
"""

import json
import sys
import io


# Capture buffer — populated by prepare_output, drained by finish.
_stdout = None   # type: ignore


def prepare_output() -> None:
    """Redirect stdout to an in-memory buffer so progress prints go to stderr."""
    global _stdout
    if _stdout is not None:
        return
    _stdout = io.StringIO()
    sys.stdout = _stdout


def finish(result, artifacts=None) -> None:
    """Flush captured buffer to stderr and emit the JSON contract to stdout.

    Args:
        result:      String, dict, or list produced by the agent's core logic.
        artifacts:   Optional list of file paths written by this agent run.
    """
    global _stdout
    if _stdout is None:
        # Guard: caller forgot prepare_output(). Emit result raw as fallback.
        raise RuntimeError('finish() called without prepare_output()')

    content = _stdout.getvalue()
    _stdout.close()
    _stdout = None

    # Drained stdout → stderr so progress / banner text still reaches the user
    # via DSH's standard log stream instead of being swallowed.
    if content:
        sys.stderr.write(content)

    sys.stdout = sys.__stdout__

    # A dict or list already carries its own contract (status, risk_category,
    # sanitized_content, ...). Wrapping it in a second envelope hides that
    # contract behind a hardcoded "success" and stacks a second envelope on
    # top of the one the bridge emits itself, so print it verbatim and let the
    # bridge wrap exactly once.
    if isinstance(result, (dict, list)):
        print(json.dumps(result, ensure_ascii=False))
        return

    # Scalars keep the envelope: a bare string has no JSON shape of its own,
    # and `artifacts` / `metadata` still need somewhere to live.
    if result is None:
        result_text = ''
    elif isinstance(result, str):
        result_text = result
    else:
        result_text = str(result)

    output = {
        'status': 'success',
        'result': result_text,
        'artifacts': list(artifacts) if artifacts else [],
        'metadata': {
            'agent_id': getattr(sys, 'agent_id', ''),
        },
    }
    print(json.dumps(output, ensure_ascii=False))