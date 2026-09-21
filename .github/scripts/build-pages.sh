#!/usr/bin/env bash
#
# Assemble the Pages site: the default branch at the root, every other branch as a preview
# under branches/<name>/. Runnable locally against a clone — ./.github/scripts/build-pages.sh
# builds into ./_site, which `python3 -m http.server` will serve as the real thing does.
set -euo pipefail

out=${1:-_site}
default=${DEFAULT_BRANCH:-main}

# Branch names are not path segments: fold anything outside a safe set to '-'. Two branches
# could in principle collide here ("a/b" and "a-b"); nothing checks, they're just previews.
slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'; }

# HTML-escape, for branch names that reach the listing page.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

# Tracked files only, and never the CI that put them there.
checkout() {
  mkdir -p "$2"
  git archive "$1" | tar -x -C "$2"
  rm -rf "$2/.github"
}

# A preview is indistinguishable from the real app otherwise — and this one is installable,
# so say which branch it is. Also keep previews out of search results.
mark_preview() {
  local dir=$1 branch=$2 name
  name=$(esc "$branch")
  [ -f "$dir/index.html" ] || return 0
  perl -0pi -e "s{</head>}{<meta name=\"robots\" content=\"noindex\">\n</head>}" "$dir/index.html"
  perl -0pi -e "s{<body>}{<body>\n<p style=\"margin:0;padding:.4rem .8rem;font:600 .75rem/1.4 system-ui,sans-serif;background:#7a4b00;color:#ffe9c2;text-align:center\">Preview of branch <code>$name</code> — <a style=\"color:inherit\" href=\"../../\">open the real app</a></p>}" "$dir/index.html"

  # An installed preview is a separate PWA, so give it a separate name: two home-screen icons
  # both reading "Can I Play It?" would be worse than no preview at all.
  # Own line, not an && chain: a false test as the function's last command would trip set -e.
  [ -f "$dir/manifest.webmanifest" ] || return 0
  python3 -c '
import json, sys
path, branch = sys.argv[1], sys.argv[2]
m = json.load(open(path))
m["name"] = m["name"] + " (" + branch + ")"
# Android shows ~12 characters under an icon; two previews can tie, but the banner and the
# full name above disambiguate.
m["short_name"] = branch.rsplit("/", 1)[-1][:12]
json.dump(m, open(path, "w"), indent=2, ensure_ascii=False)
' "$dir/manifest.webmanifest" "$branch"
}

rm -rf "$out"
mkdir -p "$out"

# `delete` events need the pruning, and a shallow checkout would hide the other branches.
git fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*'

checkout "origin/$default" "$out"

# `|| true`: grep exits 1 when the default branch is the only one, which set -e would take
# for a failure.
branches=$(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin \
  | { grep -vx -e "$default" -e HEAD || true; } | sort)

previews=''
while IFS= read -r branch; do
  [ -n "$branch" ] || continue
  dir="$out/branches/$(slug "$branch")"
  echo "preview: $branch -> ${dir#"$out"/}"
  checkout "origin/$branch" "$dir"
  mark_preview "$dir" "$branch"
  previews="$previews    <li><a href=\"$(slug "$branch")/\">$(esc "$branch")</a></li>"$'\n'
done <<< "$branches"

[ -n "$previews" ] || previews='    <li class="none">No branches besides '"$(esc "$default")"'.</li>'$'\n'

mkdir -p "$out/branches"
cat > "$out/branches/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Branch previews — Can I Play It?</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; padding: 2rem 1rem; background: #0e1116; color: #e6e9ef;
         font: 1rem/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { color: #9aa4b2; margin: 0 0 1.5rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { border-top: 1px solid #222936; }
  li.none { padding: .75rem 0; color: #9aa4b2; }
  a { display: block; padding: .75rem 0; color: #7cc0ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>Branch previews</h1>
  <p>One per branch besides <code>$(esc "$default")</code>, which is <a href="../">the site itself</a>.</p>
  <ul>
$previews  </ul>
</main>
</body>
</html>
HTML
