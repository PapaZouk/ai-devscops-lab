import { execSync } from "node:child_process";
import type { FixPlan } from "../types/RemediationSchema";

export class RemediationExecutor {
    constructor(private targetPath: string) {}

    public async execute(plan: FixPlan): Promise<void> {
        console.log("Executing remediation plan...");
        console.log('Risk Level:', plan.risk_level);

        for (const action of plan.actions) {
            try {
                console.log(`Executing action for package: ${action.package}`);
                console.log(`Running command: ${action.command}`);
                console.log(`Reason: ${action.reason}`);
    
                execSync(action.command, {
                    cwd: this.targetPath,
                    stdio: 'inherit'
                });
            } catch (error) {
                console.error(`Error executing command for package ${action.package}:`, error);
            }
        }
        
        console.log("Remediation plan execution completed.");
    }
}