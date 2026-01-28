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
        this.victimPath = path.resolve(__dirname, relativeVictimPath);
    }

    public async scan(): Promise<Vulnerability[]> {
        console.log(`Scanning project at ${this.victimPath} using Snyk...`);

        const reportPath = path.join(this.victimPath, 'report.json');

        if (fs.existsSync(reportPath)) {
            console.log("Using cached Snyk report. Loading data from file.");
            const buffer = fs.readFileSync(reportPath);

            let rawData = '';

            if (buffer[0] === 0xff && buffer[1] === 0xfe) {
                rawData = buffer.toString('utf16le');
            } else {
                rawData = buffer.toString('utf8');
            }
            return this.parseResults(rawData);
        }

        console.log("No report found. Running Snyk scan...");

        try {
            const result = spawnSync('snyk', ['test', '--json', `--output=${reportPath}`], {
                cwd: this.victimPath,
                encoding: 'utf-8'
            });
            if (result.error) {
                throw result.error;
            }
            if (result.status !== 0 && result.status !== 1) {
                throw new Error(`Snyk scan failed with status ${result.status}: ${result.stderr}`);
            }
            const reportData = fs.readFileSync(reportPath, 'utf-8');
            return this.parseResults(reportData);
        } catch (error) {
            console.error("Error during Snyk scan:", error);
            return [];
        }
    }

    private parseResults(jsonString: string): Vulnerability[] {
        try {
            const cleanJson = jsonString.replace(/^\uFEFF/, '').trim();
            const data = JSON.parse(cleanJson);
            const issues = data.vulnerabilities || [];

            return issues.map((issue: any) => ({
                id: issue.id,
                title: issue.title,
                packageName: issue.packageName,
                version: issue.version,
                severity: issue.severity,
                fixedIn: issue.fixedIn || [],
            }));
        } catch (error: any) {
            console.error("Error parsing Snyk JSON results:", error.message);
            return [];
        }
    }
}