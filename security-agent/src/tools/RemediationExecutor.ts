import { execSync } from "node:child_process";
import type { FixPlan } from "../types/RemediationSchema";
import path from "node:path";
import fs from "node:fs";

export class RemediationExecutor {
    private backupPackageJson: string = "";
    private backupLockJson: string = "";
    
    constructor(private targetPath: string) {}

    public createBackup() {
        const pkgPath = path.join(this.targetPath, "package.json");
        const lockPath = path.join(this.targetPath, "package-lock.json");

        this.backupPackageJson = fs.readFileSync(pkgPath, "utf-8");
        if (fs.existsSync(lockPath)) {
            this.backupLockJson = fs.readFileSync(lockPath, "utf-8");
        }
    }

    public rollback() {
        console.log("Rolling back changes to package files...");
        const pkgPath = path.join(this.targetPath, "package.json");
        const lockPath = path.join(this.targetPath, "package-lock.json");

        fs.writeFileSync(pkgPath, this.backupPackageJson);
        if (this.backupLockJson) {
            fs.writeFileSync(lockPath, this.backupLockJson);
        }

        console.log("Reinstalling original dependencies...");
        execSync("npm install", { cwd: this.targetPath, stdio: "ignore" });
    }

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