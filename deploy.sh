#!/usr/bin/env bash
# deploy.sh — runs the offline tests and publishes the site on GitHub Pages (okavak/la-plan).
# First run creates the public repo and turns Pages on; later runs only push main.
# GitHub credentials come from git's own credential store (the macOS keychain);
# the token is exported for gh only inside this process and never printed.
set -euo pipefail
cd "$(dirname "$0")"
OWNER="okavak"
REPO="la-plan"

if [ "$(git branch --show-current)" != "main" ]; then
  echo "Yayın main dalından yapılır. Önce: git checkout main" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Çalışma ağacında commit edilmemiş değişiklik var; önce commit edin." >&2
  exit 1
fi

npm test >/dev/null

if ! git remote get-url origin >/dev/null 2>&1; then
  if [ -z "${GH_TOKEN:-}" ]; then
    GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get | sed -n 's/^password=//p')"
    export GH_TOKEN
  fi
  if [ -z "${GH_TOKEN}" ]; then
    echo "GitHub kimlik bilgisi bulunamadı (anahtar zincirinde github.com girişi yok)." >&2
    exit 1
  fi
  gh repo create "${OWNER}/${REPO}" --public --source=. --remote=origin --push \
    --description "Hesapsız ortak tatil planı: sayfa GitHub Pages'te, paylaşılan veri Supabase'de"
  # Pages: main branch, root folder. Leave it alone if it already exists.
  if ! gh api "repos/${OWNER}/${REPO}/pages" >/dev/null 2>&1; then
    gh api -X POST "repos/${OWNER}/${REPO}/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null
  fi
else
  git push origin main
fi

echo
echo "Gönderildi. Yayın adresi: https://${OWNER}.github.io/${REPO}/ (GitHub Pages 1-2 dakikada günceller)"
