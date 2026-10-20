#!/bin/bash
# Stamp every local <script src> / stylesheet <link> in the site's HTML pages with
# ?v=<hash of that file's contents>, so browsers and Render's CDN fetch the new
# file as soon as it changes. Run before committing frontend changes:
#   ./scripts/bump-version.sh && git add -A
set -euo pipefail
cd "$(dirname "$0")/.."
for asset in $(ls *.js *.css 2>/dev/null); do
  v=$(sha1sum "$asset" | cut -c1-8)
  esc=$(printf '%s' "$asset" | sed 's/\./\\./g')
  sed -i -E "s#((src|href)=\"${esc})(\?v=[0-9a-f]+)?\"#\1?v=${v}\"#g" *.html
  echo "$asset -> v=$v"
done
