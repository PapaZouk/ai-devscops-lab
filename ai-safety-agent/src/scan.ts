import path from "node:path";
import fs from 'node:fs/promises';
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import chalk from "chalk";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "../../vulnerable-api-app");

async function runSafetyScan() {
    console.log(chalk.blue("Starting AI Safety Scan..."));

    try {
        const { stdout, stderr } = await execAsync(`npm audit --json`, { cwd: API_ROOT });
        
        if (stderr) {
            console.error(chalk.red("Error during scan:"), stderr);
            return;
        }

        processAudit(stdout);
    } catch (error: any) {
        console.error(chalk.red("Failed to run AI Safety Scan:"), error);
        if (error.stdout) {
            processAudit(error.stdout);
        } else {
            console.error(chalk.red("Failed to run audit:"), error.message);
        }
    }
}

function processAudit(auditJson: string) {
    try {
        const auditData = JSON.parse(auditJson);
        const vulnerabilities = auditData.vulnerabilities || [];
    
        const findingKeys = Object.keys(vulnerabilities);
    
        if (findingKeys.length === 0) {
            console.log(chalk.green("No vulnerabilities found!"));
            return;
        }
    
        const findings = findingKeys.map((pkg) => {
                const info = vulnerabilities[pkg];
                return {
                    package: pkg,
                    severity: info.severity.toUpperCase(),
                    via: typeof info.via[0] === 'object' ? info.via[0].title : info.via[0],
                    range: info.range,
                    fix: `npm install ${pkg}@latest`
                };
            });
    
        console.table(findings, ["package", "severity", "via", "range", "fix"]);
    
        console.log(chalk.yellow(`Total Vulnerabilities Found: ${findings.length}`));
        console.log(chalk.magenta("\nAI Remediation Plan:"))
        findings.forEach((finding, idx) => {
            console.log(chalk.cyan(`Run ${chalk.bold(finding.fix)} to address ${chalk.yellow.bold(finding.severity)} vulnerability in package ${chalk.bold(finding.package)}.`));
        });
    } catch (error) {
        console.error(chalk.red("Failed to process audit data:"), error);
    }
}

runSafetyScan();