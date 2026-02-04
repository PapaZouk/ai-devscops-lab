import { exec } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";

const execAsync = promisify(exec);

export interface BiomeDiagnostic {
    code: string;
    message: string;
    location: { start: number; end: number };
}

/**
 * Runs Biome check on a specific file and returns structured diagnostics
 */
export async function getBiomeDiagnostics(filePath: string): Promise<BiomeDiagnostic[] | null> {
    try {
        // We use --reporter=json to get machine-readable output
        // We use 'check' because it includes linting, formatting, and organization
        await execAsync(`npx @biomejs/biome check --reporter=json ${filePath}`);
        return null; // No issues found
    } catch (error: any) {
        try {
            const output = JSON.parse(error.stdout);
            
            // Extract diagnostics if they exist
            if (output.diagnostics && output.diagnostics.length > 0) {
                return output.diagnostics.map((d: any) => ({
                    code: d.category || "unknown",
                    message: d.description || "No description provided",
                    location: {
                        start: d.location?.span?.range?.[0] || 0,
                        end: d.location?.span?.range?.[1] || 0
                    }
                }));
            }
            return null;
        } catch (parseError) {
            console.error(chalk.red("Failed to parse Biome JSON output:"), parseError);
            return null;
        }
    }
}