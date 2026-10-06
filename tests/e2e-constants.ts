/**
 * Constants for e2e tests that exercise the real Python agent process.
 *
 * Measured facts behind these values (not guesses):
 *
 * - The upstream agent.py calls `requests.post(ENDPOINT, ..., timeout=30)`.
 *   There is NO retry loop in that agent — verified by grepping the source
 *   for retry/sleep and by reading sanitize() end to end.
 *
 * - Run 1 points the agent at 127.0.0.1:1 and expects a transport failure.
 *   On this host a connect() to a closed loopback port does NOT return
 *   ECONNREFUSED: measured `TimeoutError` after 5.0s for 127.0.0.1:1,
 *   127.0.0.1:9 and 127.0.0.1:59999 alike. `requests` then honours its own
 *   30s timeout and raises ConnectTimeout, which is what the agent's
 *   fail-closed branch catches. That 30s is the dominant cost of run 1.
 *
 * - The bridge budget therefore has to exceed the agent's internal 30s,
 *   otherwise the bridge kills the process before the agent can reach its
 *   own fail-closed branch and the test would assert the wrong thing.
 */

export const AGENT_INTERNAL_HTTP_TIMEOUT_MS = 30_000

/** Headroom over the agent's own timeout so the agent, not the bridge, decides the outcome. */
export const BRIDGE_TIMEOUT_HEADROOM_MS = 15_000

export const BRIDGE_E2E_TIMEOUT_MS = AGENT_INTERNAL_HTTP_TIMEOUT_MS + BRIDGE_TIMEOUT_HEADROOM_MS // 45_000

/**
 * Vitest per-test budget. Sized to the bridge budget plus margin for
 * interpreter startup, so a hang surfaces as a bridge timeout result
 * (which the test asserts on) rather than as a vitest-level timeout.
 */
export const VITEST_E2E_BUDGET_MS = Math.ceil(BRIDGE_E2E_TIMEOUT_MS * 1.2) // 54_000
