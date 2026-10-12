#!/bin/sh
# Runs tests/host.spec.ts in Bidule's real extension host: `sh scripts/check-host.sh` from this store cloned in
# bidule/bidule-store (Bidule's check-store.yml runs it on each of its pull requests). The test and its extension,
# tests/fixtures/store-probe, are copied into Bidule's checkout for the run and removed after: Bidule's repository
# never holds them. The store's own extensions, if any, are tested too once linked (`npm run store:link`).
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
bidule="$here/.."
core="$bidule/core/api"
[ -d "$core" ] || { echo "bidule/core/api introuvable : bidule-store doit être cloné dans bidule/bidule-store" >&2; exit 1; }
probe="$bidule/extensions/store-probe"
[ -e "$probe" ] && { echo "bidule/extensions/store-probe existe déjà : rien n'est copié par-dessus" >&2; exit 1; }
target="$core/tests/functional/store_contract.spec.ts"
trap 'rm -rf "$probe" "$target"' EXIT
cp -R "$here/tests/fixtures/store-probe" "$probe"
cp "$here/tests/host.spec.ts" "$target"
cd "$core"
node ace test functional --files=store_contract.spec.ts --force-exit
