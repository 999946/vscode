#!/usr/bin/env bash
#
# Launches Code OSS from sources in a throwaway profile prepared for Spaces
# validation: Spaces enabled, two small git repositories, the Spaces probe
# extension installed and its control endpoint enabled.
#
# Usage: test/spaces/launch-validation.sh [runDir]
#
# Keep runDir short: the main IPC socket lives inside the user data dir and
# macOS limits socket paths to 103 characters.
#
# Then, in another shell:
#   node test/spaces/validateSpaces.ts <runDir>/probe 9334 <runDir>/projects/project-a <runDir>/projects/project-b

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="${1:-/tmp/vscode-spaces-validation}"
MAIN_INSPECT_PORT="${MAIN_INSPECT_PORT:-9334}"

mkdir -p "$RUN/udd/User" "$RUN/ext" "$RUN/shared" "$RUN/probe" "$RUN/projects"

for project in project-a project-b; do
	if [[ ! -d "$RUN/projects/$project/.git" ]]; then
		mkdir -p "$RUN/projects/$project"
		(
			cd "$RUN/projects/$project"
			git init -q
			echo "# $project" > README.md
			echo "console.log('$project');" > index.js
			git add .
			git -c user.name=spaces -c user.email=spaces@example.com commit -qm init
			echo "uncommitted change in $project" >> README.md
		)
	fi
done

if [[ ! -f "$RUN/udd/User/settings.json" ]]; then
	cat > "$RUN/udd/User/settings.json" <<'EOF'
{
	"workbench.experimental.spaces.enabled": true,
	"security.workspace.trust.enabled": false,
	"window.restoreWindows": "none",
	// In-window dialogs keep hidden Spaces hidden, so the attention marker can be validated
	"window.dialogStyle": "custom",
	"workbench.startupEditor": "none",
	"telemetry.telemetryLevel": "off",
	"update.mode": "none"
}
EOF
fi

# Fresh probe output and no hot-exit backups from a previous run
rm -rf "$RUN/probe/"* "$RUN/udd/Backups"

node "$ROOT/test/spaces/installSpacesProbe.ts" "$RUN/ext"

echo "Validate with:"
echo "  node test/spaces/validateSpaces.ts $RUN/probe $MAIN_INSPECT_PORT $RUN/projects/project-a $RUN/projects/project-b"

# ELECTRON_RUN_AS_NODE leaks in when launched from an extension host (e.g. an agent running inside VS Code)
exec env -u ELECTRON_RUN_AS_NODE \
	SPACES_PROBE_DIR="$RUN/probe" \
	SPACES_PROBE_CONTROL=1 \
	"$ROOT/scripts/code.sh" \
	--user-data-dir="$RUN/udd" \
	--extensions-dir="$RUN/ext" \
	--shared-data-dir="$RUN/shared" \
	--inspect="$MAIN_INSPECT_PORT" \
	--disable-workspace-trust \
	--skip-welcome \
	--skip-release-notes \
	"$RUN/projects/project-a"
