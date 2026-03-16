#!/usr/bin/env bash
# Updates floating major (v1) and minor (v1.5) tags after a release.
# Called by semantic-release via successCmd with the version as argument.
# Example: ./scripts/update-floating-tags.sh 1.5.0

set -euo pipefail

VERSION="$1"
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f1-2)

echo "Updating floating tags: v${MAJOR} → v${VERSION}, v${MINOR} → v${VERSION}"

git tag -f "v${MAJOR}" "v${VERSION}"
git tag -f "v${MINOR}" "v${VERSION}"
git push origin "v${MAJOR}" "v${MINOR}" --force
