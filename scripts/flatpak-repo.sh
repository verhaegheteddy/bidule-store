#!/bin/sh
# Copied from the app's repo (verhaegheteddy/bidule, scripts/flatpak-repo.sh): keep both the same.
# Builds the app's Flatpak repo from a Flatpak made by electron-builder, signed, with what users add it with:
#   sh scripts/flatpak-repo.sh <Bidule-X.Y.Z.flatpak> <site folder> <site URL>
# <site>/flatpak/repo is the OSTree repo (the latest version only: a client updates from whatever it has, fetching
# the files that changed), <site>/flatpak/bidule.flatpakrepo adds it, <site>/flatpak/bidule.flatpakref adds it and
# installs the app. The site is deployed on the GitHub Pages of bidule-store by its own workflow (an artifact, not a
# branch: one of the repo's objects, Electron, is close to git's 100 MB limit per file).
# The GPG key: FLATPAK_GPG_KEY (armored secret key, the CI's secret), else ~/.config/bidule/signing/flatpak-private.asc.
set -eu

bundle=$1
site=$2
url=${3%/}
app=io.github.verhaegheteddy.bidule
repo=$site/flatpak/repo

gpghome=$(mktemp -d)
trap 'rm -rf "$gpghome"' EXIT
chmod 700 "$gpghome"
if [ -n "${FLATPAK_GPG_KEY:-}" ]; then
  printf '%s\n' "$FLATPAK_GPG_KEY" | gpg --homedir "$gpghome" --batch --quiet --import
else
  gpg --homedir "$gpghome" --batch --quiet --import "$HOME/.config/bidule/signing/flatpak-private.asc"
fi
key=$(gpg --homedir "$gpghome" --list-secret-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')

rm -rf "$repo"
mkdir -p "$repo"
ostree init --repo="$repo" --mode=archive-z2
flatpak build-import-bundle --gpg-sign="$key" --gpg-homedir="$gpghome" "$repo" "$bundle"
flatpak build-update-repo --gpg-sign="$key" --gpg-homedir="$gpghome" --title=Bidule --default-branch=master \
  --generate-static-deltas "$repo"

pubkey=$(gpg --homedir "$gpghome" --export "$key" | base64 -w0)
cat > "$site/flatpak/bidule.flatpakrepo" <<REPO
[Flatpak Repo]
Title=Bidule
Url=$url/flatpak/repo/
Homepage=https://github.com/verhaegheteddy/bidule-store
Comment=Le truc à tout faire du développeur
GPGKey=$pubkey
REPO
cat > "$site/flatpak/bidule.flatpakref" <<REF
[Flatpak Ref]
Name=$app
Branch=master
Title=Bidule
Url=$url/flatpak/repo/
SuggestRemoteName=bidule
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
GPGKey=$pubkey
REF
# GitHub Pages must not run Jekyll on the repo (it skips files and folders it does not know).
touch "$site/.nojekyll"
echo "$app ajouté à $repo"
