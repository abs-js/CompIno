#!/bin/sh
# Publish this version folder to npm.
# npm requires an interactive 2FA code, or a granular token with bypass 2FA.
# Usage:
#   sh scripts/publish-npm.sh
#   NPM_OTP=123456 sh scripts/publish-npm.sh
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
echo "Publishing compino@${VERSION} (folder v0.1.1B) to npm..."
if [ -n "$NPM_OTP" ]; then
  npm publish --access public --tag beta --otp="$NPM_OTP"
else
  npm publish --access public --tag beta
fi
echo "Published. Try: npx compino@beta --help"

