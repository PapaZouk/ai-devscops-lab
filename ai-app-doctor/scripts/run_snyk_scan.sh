#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:?target dir is required}"
REPORT_PATH="${2:?report path is required}"
PROJECT_NAME="${3:?project name is required}"
SNYK_TOKEN="${SNYK_TOKEN:?SNYK_TOKEN env var is required}"

cd "$TARGET_DIR"

npm install -g snyk
snyk auth "$SNYK_TOKEN"

# Continue even when vulnerabilities are found.
snyk test --json --severity-threshold=high --project-name="$PROJECT_NAME" > "$REPORT_PATH" || true

# Keep only actionable high/critical data for the remediation agent.
if command -v jq >/dev/null 2>&1; then
  jq '{
        ok,
        summary,
        severityThreshold,
        projectName,
        packageManager,
        path,
        remediation: {
          upgrade: (.remediation.upgrade // {}),
          unresolved: (.remediation.unresolved // [])
        },
        vulnerabilities: (
          (.vulnerabilities // [])
          | map(select(.severity=="high" or .severity=="critical"))
          | map({
              id,
              title,
              severity,
              cvssScore,
              packageName: (.packageName // .moduleName // .name),
              version,
              from: (.from // []),
              fixedIn: (.fixedIn // []),
              upgradePath: (.upgradePath // []),
              isUpgradable,
              isPatchable,
              identifiers: (.identifiers // {}),
              references: ((.references // []) | map({title, url}))
            })
        )
      }' "$REPORT_PATH" > "${REPORT_PATH}.tmp"
  mv "${REPORT_PATH}.tmp" "$REPORT_PATH"
fi

echo "✅ Snyk scan completed. Report saved to $REPORT_PATH"
