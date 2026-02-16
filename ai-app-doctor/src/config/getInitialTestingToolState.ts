import { TestingToolState } from "../types/TestingToolState.js";

export const getInitialTestingToolState = (): TestingToolState => ({
    consecutiveRunTestsFailures: 0,
    runTestsFailureStreakHinted: 0,
    hasPassingTestRun: false,
    lastRunTestsSummary: null,
    lastRunTestsFailureFingerprint: null,
    repeatedRunTestsFailureCount: 0,
    lastFailingTestPath: null,
    testingPhase: "discover",
    discoveredContext: false,
    wroteTestSinceLastRun: false,
    remediationRequiresSourceRead: false,
    remediationTestReadDone: false,
    remediationSourceReadDone: false,
});