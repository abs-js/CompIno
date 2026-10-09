#!/bin/sh
# Publish this version folder to npm.
# Requires `npm login` already completed on this machine.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
echo "Publishing compino@${VERSION} (folder v0.1.0B) to npm..."
npm publish --access public --tag beta
echo "Published. Try: npx compino@beta --help"
