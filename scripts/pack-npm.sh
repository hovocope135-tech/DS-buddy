#!/usr/bin/env bash
# Build the npm package people install with one line, no clone:
#
#   dsh plugin --profile web add deepseek-harness-projects-plugin@preview
#
#   bash scripts/pack-npm.sh [version] [out-dir]     → out-dir/deepseek-harness-projects-plugin-<version>.tgz
#
# The source keeps its own package name (dsh-mira-projects), which existing installs are registered under; only the
# packed copy is renamed: in package.json, in the cordis patch that names the bundle, and where the page code
# registers itself with DSH's module loader, so all three stay in step.
# Publishing is a separate, deliberate step: npm publish <tgz> (the package publishes under the `preview` tag).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME=deepseek-harness-projects-plugin
VERSION="${1:-$(node -p "require('$ROOT/plugin/package.json').version")}"
OUT="$(mkdir -p "${2:-$ROOT/dist}" && cd "${2:-$ROOT/dist}" && pwd)"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT

cp -R "$ROOT/plugin/lib" "$ROOT/plugin/cordis.patch.yml" "$ROOT/plugin/package.json" "$STAGE/"
cp "$ROOT/README.md" "$ROOT/README.en.md" "$ROOT/LICENSE" "$STAGE/"
find "$STAGE/lib" -name '*.orig' -delete

node - "$STAGE/package.json" "$NAME" "$VERSION" <<'JS'
const fs = require('fs'), [file, name, version] = process.argv.slice(2), p = JSON.parse(fs.readFileSync(file, 'utf8'))
Object.assign(p, {
  name, version,
  repository: { type: 'git', url: 'git+https://github.com/hovocope135-tech/DSH-projects.git' },
  homepage: 'https://github.com/hovocope135-tech/DSH-projects#readme',
  bugs: { url: 'https://github.com/hovocope135-tech/DSH-projects/issues' },
  keywords: ['deepseek-harness', 'dsh', 'dsh-plugin', 'agents', 'projects'],
  license: p.license ?? 'MIT',
  files: ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE'],
  publishConfig: { access: 'public', tag: 'preview' },
})
delete p.private; delete p.scripts; delete p.devDependencies
fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n')
JS
# The bundle's layer names the package it loads: it must be the published name.
grep -q '^      name: dsh-mira-projects$' "$STAGE/cordis.patch.yml"
sed -i.bak 's/^      name: dsh-mira-projects$/      name: '"$NAME"'/' "$STAGE/cordis.patch.yml" && rm "$STAGE/cordis.patch.yml.bak"
# The page code registers itself with DSH's module loader under the package name too (first lines of lib/client.js).
grep -q '^	id: "dsh-mira-projects",$' "$STAGE/lib/client.js"
sed -i.bak '2s/^	id: "dsh-mira-projects",$/	id: "'"$NAME"'",/' "$STAGE/lib/client.js" && rm "$STAGE/lib/client.js.bak"
# (lib/runtime/node-main.js keeps the source name: the container mode installs the plugin from source, not from npm.)
! grep -q 'dsh-mira-projects' "$STAGE/lib/client.js" "$STAGE/cordis.patch.yml" || { echo "old package name still in the bundle or page code" >&2; exit 1; }

(cd "$STAGE" && npm pack --silent --pack-destination "$OUT" >/dev/null)
echo "$OUT/$NAME-$VERSION.tgz"
