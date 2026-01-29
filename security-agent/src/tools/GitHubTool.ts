import { execSync } from "node:child_process";
import * as path from "node:path";

export class GitHubTool {
    private currentBranchName: string;

    constructor(private repoRoot: string) {
        this.currentBranchName = `fix/security-remediation-${Date.now()}`;
    }

    public getBranchName(): string {
        return this.currentBranchName;
    }

    public createBranch(): void {
        console.log(`Creating branch: ${this.currentBranchName}`);
        execSync(`git checkout -b ${this.currentBranchName}`, { cwd: this.repoRoot });
    }

    public commitAndPush(message: string): void {
        console.log("Committing and pushing changes...");
        execSync(`git add victim-app/`, { cwd: this.repoRoot });
        execSync(`git commit -m "${message}"`, { cwd: this.repoRoot });
        execSync(`git push -u origin ${this.currentBranchName}`, { cwd: this.repoRoot });
    }

    public async createPullRequest(title: string, body: string): Promise<void> {
        console.log("Creating GitHub Pull Request automatically...");
        
        const prCommand = `gh pr create \
            --title "${title}" \
            --body "${body}" \
            --head "${this.currentBranchName}" \
            --base master`;

        try {
            execSync(prCommand, { 
                cwd: this.repoRoot, 
                stdio: 'inherit' 
            });
            console.log("PR successfully opened on GitHub.");
            this.switchToMaster();
        } catch (error) {
            console.error("Failed to create PR. Returning to master branch for safety.");
            this.switchToMaster();
            throw error;
        }
    }

    private switchToMaster(): void {
        console.log("Switching back to master branch...");
        try {
            execSync('git checkout master', { cwd: this.repoRoot, stdio: 'ignore' });
        } catch (e) {
            console.error("Could not switch to master. Ensure the branch name is correct.");
        }
    }

    public rollbackToMain(): void {
        this.switchToMaster();
    }
}