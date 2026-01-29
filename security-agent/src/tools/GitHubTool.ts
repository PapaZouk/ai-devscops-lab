import { execSync, spawnSync } from "node:child_process";
import * as path from "node:path";

export class GitHubTool {
    private currentBranchName: string;

    constructor(private repoRoot: string) {
        this.currentBranchName = `fix/security-remediation-${Date.now()}`;
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
        const result = spawnSync('gh', [
            'pr', 'create',
            '--title', title,
            '--body', body,
            '--head', this.currentBranchName,
            '--base', 'master'
        ], { 
            cwd: this.repoRoot,
            encoding: 'utf-8' 
        });

        if (result.status === 0) {
            console.log("PR successfully opened on GitHub.");
            console.log(result.stdout);
            this.cleanupLocalBranch();
        } else {
            if (result.stderr?.includes("already exists")) {
                console.log("PR already exists. Skipping creation and cleaning up.");
                this.cleanupLocalBranch();
            } else {
                console.error("Failed to create PR:", result.stderr);
                this.rollbackToMain();
                throw new Error("GitHub PR creation failed.");
            }
        }
    }

    private cleanupLocalBranch(): void {
        console.log(`Cleaning up local branch: ${this.currentBranchName}`);
        try {
            execSync('git checkout master', { cwd: this.repoRoot, stdio: 'ignore' });
            execSync(`git branch -D ${this.currentBranchName}`, { cwd: this.repoRoot, stdio: 'ignore' });
            console.log("Local workspace is clean.");
        } catch (e) {
            console.error("Cleanup failed, but PR might be live.");
        }
    }

    public rollbackToMain(): void {
        try {
            execSync('git checkout master', { cwd: this.repoRoot, stdio: 'ignore' });
        } catch (e) {}
    }
}