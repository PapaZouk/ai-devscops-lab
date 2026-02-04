import { execSync, spawnSync } from 'child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface Vulnerability {
    id: string;
    title: string;
    packageName: string;
    version: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    fixedIn: string[];
}

export class SnykTool {
    private victimPath: string;

    constructor(relativeVictimPath: string) {
        const __filename = new URL('', import.meta.url).pathname;
        const __dirname = path.dirname(__filename);
        this.victimPath = path.resolve(__dirname, relativeVictimPath);
    }

    public async scan(): Promise<Vulnerability[]> {
        console.log(`Scanning project at ${this.victimPath} using Snyk...`);

        const result = spawnSync('snyk', ['test', '--json', '--severity-threshold=high'], {
            cwd: this.victimPath,
            encoding: 'utf-8'
        });

        if (result.status !== 0 && result.status !== 1) {
            console.error("Snyk CLI failed to execute. Ensure Snyk is installed and authenticated.");
            if (result.stderr) console.error("Error details:", result.stderr);
            return [];
        }

        if (!result.stdout) {
            console.error("Snyk produced no output.");
            return [];
        }

        const reportPath = path.join(this.victimPath, 'report.json');
        fs.writeFileSync(reportPath, result.stdout);

        return this.parseResults(result.stdout);
    }

    private parseResults(jsonString: string): Vulnerability[] {
        try {
            // Remove potential UTF-8 BOM characters
            const cleanJson = jsonString.replace(/^\uFEFF/, '').trim();
            const data = JSON.parse(cleanJson);
            
            const results = Array.isArray(data) ? data : [data];
            const vulnerabilities: Vulnerability[] = [];

            for (const result of results) {
                const issues = result.vulnerabilities || [];
                issues.forEach((issue: any) => {
                    vulnerabilities.push({
                        id: issue.id,
                        title: issue.title,
                        packageName: issue.packageName,
                        version: issue.version,
                        severity: issue.severity,
                        fixedIn: issue.fixedIn || [],
                    });
                });
            }

            console.table(vulnerabilities, ['id', 'packageName', 'version', 'severity', 'fixedIn']);
            return vulnerabilities;
        } catch (error: any) {
            console.error("Failed to parse Snyk JSON. Output might not be valid JSON.");
            return [];
        }
    }
}