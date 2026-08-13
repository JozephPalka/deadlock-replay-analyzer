#!/usr/bin/env bash
# Publish the analyzer to GitHub Pages. Safe to run more than once.
set -euo pipefail

REPO="deadlock-replay-analyzer"
cd "$(dirname "$0")"

command -v git >/dev/null || { echo "git is not installed."; exit 1; }
command -v gh  >/dev/null || { echo "The GitHub CLI is not installed: https://cli.github.com/"; exit 1; }

gh auth status >/dev/null 2>&1 || gh auth login

OWNER="$(gh api user --jq .login)"
echo "Signed in as $OWNER."

[ -d .git ] || git init -b main
git config user.name  >/dev/null 2>&1 || git config user.name  "$OWNER"
git config user.email >/dev/null 2>&1 || git config user.email "$OWNER@users.noreply.github.com"

git add -A
if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -m "Update Deadlock replay analyzer" >/dev/null
  echo "Committed local changes."
fi

if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "Repository already exists, pushing to it..."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git push -u origin main
else
  echo "Creating github.com/$OWNER/$REPO ..."
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi

echo "Turning on GitHub Pages (source: GitHub Actions)..."
gh api -X POST "repos/$OWNER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 \
  || echo "  (could not set it via the API - do it in Settings -> Pages)"

echo
echo "Repo     https://github.com/$OWNER/$REPO"
echo "Actions  https://github.com/$OWNER/$REPO/actions"
echo "Site     https://$OWNER.github.io/$REPO/"
