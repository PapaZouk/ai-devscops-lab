import { Client } from "@modelcontextprotocol/sdk/client";
import { TestingToolState } from "./TestingToolState.js";

export interface BaseProcessToolCallParams {
    client: Client;
    isTestingAgent: boolean;
    maxToolRetries: number;
    maxRunTestsConsecutiveFailures: number;
    state: TestingToolState;
    targetSourcePath: string;
    maxHistoryToolOutput: number;
}