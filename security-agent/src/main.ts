import * as path from "node:path";
import { execSync } from "node:child_process";
import { SnykTool } from "./tools/SnykTool";
import { AIEngine } from "./tools/AIEngine";
import { RemediationExecutor } from "./tools/RemediationExecutor";
import { GitHubTool } from "./tools/GitHubTool";

async function startAgent() {
    console.log("Security Agent started...");

    const __filename = new URL('', import.meta.url).pathname;
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..", "..");
    const victimPath = path.resolve(repoRoot, "victim-app");
    
    const snyk = new SnykTool(victimPath);
    const ai = new AIEngine();
    const executor = new RemediationExecutor(victimPath);
    const github = new GitHubTool(repoRoot);
    
    const MAX_ATTEMPTS = 3;
    let attempt = 1;
    let success = false;

    while (attempt <= MAX_ATTEMPTS && !success) {
        console.log(`--- Attempt ${attempt} ---`);
        const vulnerabilities = await snyk.scan();

        if (vulnerabilities.length > 0) {
            const plan = await ai.suggestFix(vulnerabilities);

            if (plan) {
                executor.createBackup();
                console.log("Applying remediation plan...");
                await executor.execute(plan);

                try {
                    console.log("Running regression tests...");
                    execSync('npm test', { 
                        cwd: victimPath, 
                        env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules --no-warnings' },
                        stdio: 'inherit'
                    });

                    console.log("Verifying security fixes...");
                    const remaining = await snyk.scan();

                    if (remaining.length === 0) {
                        console.log("All vulnerabilities fixed. Finalizing PR...");
                        
                        github.createBranch();
                        github.commitAndPush("security: automated fix for all identified vulnerabilities");
                        
                        const prMetadata = await ai.generatePRDescription(vulnerabilities);
                        await github.createPullRequest(prMetadata.title, prMetadata.body);
                        
                        success = true;
                    } else {
                        console.log(`${remaining.length} vulnerabilities still remain. Retrying...`);
                        attempt++;
                    }
                } catch (error) {
                    console.error("Workflow failed. Rolling back changes.");
                    executor.rollback();
                    github.rollbackToMain();
                    break;
                }
            }
        } else {
            console.log("No vulnerabilities to fix.");
            success = true;
        }
    }

    console.log(success ? "Agent finished successfully." : "Agent finished with errors.");
}

startAgent();