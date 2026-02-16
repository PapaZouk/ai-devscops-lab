export interface OrchestratorRuntimeConfig {
  maxTurns: number;
  maxToolRetries: number;
  maxRunTestsConsecutiveFailures: number;
  maxRateLimitRetries: number;
  maxHistoryToolArgs: number;
  maxHistoryToolOutput: number;
  shouldSkipDelivery: boolean;
  lmBaseUrl: string;
  lmApiKey: string;
  lmModel?: string;
  targetSourcePath: string;
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getOrchestratorRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): OrchestratorRuntimeConfig {
  return {
    maxTurns: toPositiveInt(env.ORCH_MAX_TURNS, 40),
    maxToolRetries: toPositiveInt(env.ORCH_MAX_TOOL_RETRIES, 3),
    maxRunTestsConsecutiveFailures: toPositiveInt(
      env.ORCH_MAX_RUN_TESTS_CONSECUTIVE_FAILURES,
      6
    ),
    maxRateLimitRetries: toPositiveInt(env.LM_MAX_RATE_LIMIT_RETRIES, 4),
    maxHistoryToolArgs: toPositiveInt(env.ORCH_MAX_HISTORY_TOOL_ARGS, 1500),
    maxHistoryToolOutput: toPositiveInt(env.ORCH_MAX_HISTORY_TOOL_OUTPUT, 12000),
    shouldSkipDelivery: env.SKIP_DELIVERY === "true" || env.ACT === "test",
    lmBaseUrl: env.LM_BASE_URL || "http://localhost:1234/v1",
    lmApiKey: env.LM_API_KEY || "dummy-key",
    lmModel: env.LM_MODEL, // optional override, can be set via AgentConfig as well
    targetSourcePath: (env.TARGET_TEST_FILE || "").trim()
  };
}
