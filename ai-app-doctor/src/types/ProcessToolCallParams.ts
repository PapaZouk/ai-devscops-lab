import { BaseProcessToolCallParams } from "./BaseProcessToolCallParams.js";

export interface ProcessToolCallParams extends BaseProcessToolCallParams {
    call: any;
    toolRetryCounter: Map<string, number>;
}