#!/usr/bin/env bash
# Creates a throwaway repo with a three-layer stack (main <- auth <- api <- ui)
# tracked by gh stack, plus one unstacked branch, for trying Cairn in the
# Extension Development Host.
#
#   scripts/make-demo-stack.sh [dir]        default: .demo/stack
#
# Set CAIRN_DEMO_SEPARATE_GIT_DIR=1 to keep the git dir outside the worktree.
set -euo pipefail

dir="${1:-.demo/stack}"
if [ -e "$dir" ]; then
  echo "$dir already exists" >&2
  exit 1
fi
command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }
gh stack --version >/dev/null 2>&1 || { echo "gh stack is not installed: gh extension install github/gh-stack" >&2; exit 1; }

mkdir -p "$(dirname "$dir")"
if [ "${CAIRN_DEMO_SEPARATE_GIT_DIR:-}" = 1 ]; then
  git init --quiet -b main --separate-git-dir="$(cd "$(dirname "$dir")" && pwd)/$(basename "$dir").gitdir" "$dir"
else
  git init --quiet -b main "$dir"
fi
cd "$dir"
git config user.email "demo@example.com"
git config user.name "Cairn Demo"
git config commit.gpgsign false
git config rerere.enabled true

commit() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git add -- "$1"; git commit --quiet -m "$3"; }

commit README.md "# demo" "Initial commit"
commit src/server.ts "export const port = 3000;" "Add server"

git checkout --quiet -b feat/auth
commit src/auth/middleware.ts "export function requireUser() { return true; }" "Add auth middleware"
commit src/auth/session.ts "export const sessionTtl = 3600;" "Add session TTL"

git checkout --quiet -b feat/api
commit src/api/users.ts "export function getUser(id: string) { return { id }; }" "Add get-user endpoint"

git checkout --quiet -b feat/ui
commit src/ui/Profile.tsx "export const Profile = () => null;" "Add profile page"

git checkout --quiet main
git checkout --quiet -b docs/onboarding
commit docs/onboarding.md "Read the README." "Add onboarding doc"
git checkout --quiet main

gh stack init feat/auth feat/api feat/ui --base main
echo
gh stack view --json
