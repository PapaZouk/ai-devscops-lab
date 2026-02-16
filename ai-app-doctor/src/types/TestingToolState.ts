import { TestingPhase } from "./TestingPhase.js";

export interface TestingToolState {
    consecutiveRunTestsFailures: number;
    runTestsFailureStreakHinted: number;
    hasPassingTestRun: boolean;
    lastRunTestsSummary: string | null;
    lastRunTestsFailureFingerprint: string | null;
    repeatedRunTestsFailureCount: number;
    lastFailingTestPath: string | null;
    testingPhase: TestingPhase;
    discoveredContext: boolean;
    wroteTestSinceLastRun: boolean;
    remediationRequiresSourceRead: boolean;
    remediationTestReadDone: boolean;
    remediationSourceReadDone: boolean;
}