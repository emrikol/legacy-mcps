#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
destination=${1:-"$repo_root/tools/dosbox-x-src"}
created=false

cleanup() {
  status=$?
  if [[ $status -ne 0 && $created == true && -d $destination ]]; then
    rm -rf -- "$destination"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e "$destination" ]]; then
  echo "Destination already exists: $destination" >&2
  exit 1
fi

node "$repo_root/scripts/verify-dosbox-x-patches.js"
read -r upstream base base_tree < <(
  node "$repo_root/scripts/verify-dosbox-x-patches.js" --print-base
)

created=true
git init -- "$destination"
git -C "$destination" remote add origin "$upstream"
git -C "$destination" fetch --depth=1 origin "$base"
git -C "$destination" checkout --detach FETCH_HEAD
actual_base_tree=$(git -C "$destination" rev-parse 'HEAD^{tree}')
if [[ $actual_base_tree != "$base_tree" ]]; then
  echo "Unexpected DOSBox-X base tree: $actual_base_tree" >&2
  exit 1
fi
git -C "$destination" switch -c legacy-mcps-debugger

patches=()
while IFS= read -r patch; do
  patches+=("$repo_root/$patch")
done < <(node "$repo_root/scripts/verify-dosbox-x-patches.js" --print-patches)
git -C "$destination" am "${patches[@]}"
node "$repo_root/scripts/update-dosbox-x-identity.js" --check "$destination"
node "$repo_root/scripts/verify-dosbox-x-patches.js" --source-root "$destination"

echo "Patched DOSBox-X source is ready at $destination"
