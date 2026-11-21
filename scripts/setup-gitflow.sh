#!/usr/bin/env bash
# Sets a repository up for the gitflow workflows (README.md, "Setting up a repository"):
#
#   scripts/setup-gitflow.sh OWNER/REPO [--main main] [--develop develop] [--dry-run]
#
# 1. Rulesets: a ruleset on the default branch is moved to the main branch by name (merge commits
#    only, no linear-history rule); a main ruleset is created if none covers it; a develop ruleset
#    (squash or merge, no linear-history rule) is created if none covers develop. Done first, so the
#    main branch is never unprotected.
# 2. Creates the develop branch from main if it is missing, and makes it the default branch.
# 3. Lets the github-pages environment, if it has deployment rules, deploy from v* tags.
# 4. Checks for the RELEASE_TOKEN secret, which it cannot create.
#
# Safe to run again: each step checks first. --dry-run prints every change instead of making it.
# Needs gh (signed in, with admin rights on the repository) and jq.
set -euo pipefail

repo="" main=main develop=develop dry=""
while [ $# -gt 0 ]; do
  case "$1" in
    --main) main="$2"; shift 2 ;;
    --develop) develop="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) repo="$1"; shift ;;
  esac
done
[ -n "$repo" ] || { echo "usage: $0 OWNER/REPO [--main main] [--develop develop] [--dry-run]" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
# A change: made, or only printed with --dry-run. The JSON body, if any, comes on stdin.
change() {
  local method="$1" path="$2" what="$3"
  if [ -n "$dry" ]; then
    say "  would: $what"
    [ -t 0 ] || sed 's/^/    /'
  else
    if [ -t 0 ]; then gh api -X "$method" "$path" --silent; else gh api -X "$method" "$path" --input - --silent; fi
    say "  done: $what"
  fi
}

say "$repo${dry:+ (dry run)}"
default=$(gh api "repos/$repo" --jq .default_branch)
gh api "repos/$repo/branches/$main" --silent 2>/dev/null || { echo "no $main branch in $repo (use --main)" >&2; exit 1; }

say "Rulesets"
main_covered="" develop_covered=""
for id in $(gh api "repos/$repo/rulesets" --jq '.[] | select(.target == "branch") | .id'); do
  rs=$(gh api "repos/$repo/rulesets/$id")
  name=$(jq -r .name <<< "$rs")
  includes=$(jq -c '.conditions.ref_name.include // []' <<< "$rs")
  if jq -e --arg d "refs/heads/$default" 'index("~DEFAULT_BRANCH") or index($d)' <<< "$includes" >/dev/null \
      && [ "$default" = "$main" ]; then
    # Applies to the default branch, which is about to become develop: pin it to main.
    jq --arg m "refs/heads/$main" '{
        name, target, enforcement, bypass_actors,
        conditions: {ref_name: {include: [$m], exclude: (.conditions.ref_name.exclude // [])}},
        rules: [.rules[]
          | select(.type != "required_linear_history")
          | if .type == "pull_request" then .parameters.allowed_merge_methods = ["merge"] else . end
          | {type} + (if .parameters then {parameters} else {} end)]
      }' <<< "$rs" | change PUT "repos/$repo/rulesets/$id" \
      "ruleset '$name': target $main by name, merge commits only, no linear history"
    main_covered=1
  elif jq -e 'index("~DEFAULT_BRANCH")' <<< "$includes" >/dev/null; then
    say "  WARNING: ruleset '$name' targets the default branch ($default), not $main or $develop by name: check it by hand"
  elif jq -e --arg m "refs/heads/$main" 'index($m)' <<< "$includes" >/dev/null; then
    say "  ok: ruleset '$name' covers $main"
    main_covered=1
  fi
  if jq -e --arg d "refs/heads/$develop" 'index($d)' <<< "$includes" >/dev/null; then
    say "  ok: ruleset '$name' covers $develop"
    develop_covered=1
  fi
done
ruleset() { # name branch merge-methods-json
  jq -n --arg n "$1" --arg b "refs/heads/$2" --argjson methods "$3" '{
    name: $n, target: "branch", enforcement: "active",
    conditions: {ref_name: {include: [$b], exclude: []}},
    rules: [
      {type: "deletion"}, {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: false, allowed_merge_methods: $methods}}
    ]}'
}
[ -n "$main_covered" ] || ruleset "$main" "$main" '["merge"]' \
  | change POST "repos/$repo/rulesets" "ruleset '$main': pull request required, merge commits only"
[ -n "$develop_covered" ] || ruleset "$develop" "$develop" '["squash","merge"]' \
  | change POST "repos/$repo/rulesets" "ruleset '$develop': pull request required, squash or merge"

say "Branches"
if gh api "repos/$repo/branches/$develop" --silent 2>/dev/null; then
  say "  ok: $develop exists"
else
  sha=$(gh api "repos/$repo/branches/$main" --jq .commit.sha)
  jq -n --arg r "refs/heads/$develop" --arg s "$sha" '{ref: $r, sha: $s}' \
    | change POST "repos/$repo/git/refs" "create $develop from $main (${sha:0:7})"
fi
if [ "$default" = "$develop" ]; then
  say "  ok: $develop is the default branch"
else
  jq -n --arg d "$develop" '{default_branch: $d}' \
    | change PATCH "repos/$repo" "make $develop the default branch (was $default)"
fi

say "Environments"
if policy=$(gh api "repos/$repo/environments/github-pages" --jq '.deployment_branch_policy.custom_branch_policies // false' 2>/dev/null); then
  if [ "$policy" = true ]; then
    if gh api "repos/$repo/environments/github-pages/deployment-branch-policies" \
        --jq '.branch_policies[] | select(.type == "tag" and .name == "v*") | .id' | grep -q .; then
      say "  ok: github-pages allows v* tags"
    else
      jq -n '{name: "v*", type: "tag"}' | change POST \
        "repos/$repo/environments/github-pages/deployment-branch-policies" "github-pages: allow v* tags"
    fi
  else
    say "  ok: github-pages has no custom deployment rules"
  fi
else
  say "  ok: no github-pages environment"
fi

say "Secrets"
if gh api "repos/$repo/actions/secrets" --jq '.secrets[].name' | grep -qx RELEASE_TOKEN; then
  say "  ok: RELEASE_TOKEN is set"
else
  say "  TODO: add the RELEASE_TOKEN secret (https://github.com/zmnatz/github-workflows#the-token):"
  say "        https://github.com/$repo/settings/secrets/actions/new"
fi
