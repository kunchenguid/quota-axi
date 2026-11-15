#!/usr/bin/env bash
#
# Decide whether a guarded release-please-generated file may change in this PR.
#
# It may change only when EVERY commit in BASE..HEAD that touches the path is an
# upstream release commit, established from facts fetched from the upstream
# repository through the GitHub API using the workflow's own token. Deliberately
# no author name or email is consulted anywhere: those fields are arbitrary,
# committer-chosen git metadata and cannot authorize anything.
#
# Exit 0 -> exempt (inherited upstream release content).
# Exit 1 -> not exempt; the caller reports the ordinary hand-edit violation.
#
# Any API error, missing field, or mismatch exits non-zero: the check fails closed.

set -euo pipefail

BASE_SHA=${1:?base sha required}
HEAD_SHA=${2:?head sha required}
GUARDED_PATH=${3:?guarded path required}

UPSTREAM_REPO=${UPSTREAM_REPO:-kunchenguid/quota-axi}
EXPECTED_SIGNER=${EXPECTED_SIGNER:-github-actions[bot]}

# Commits are enumerated locally only to decide WHAT must be vouched for. Every
# fact that authorizes the exemption is fetched from the upstream API below.
commits=$(git log --format=%H "${BASE_SHA}..${HEAD_SHA}" -- "${GUARDED_PATH}")
[ -n "${commits}" ] || exit 1

default_branch=$(gh api "repos/${UPSTREAM_REPO}" --jq '.default_branch')
[ -n "${default_branch}" ] || exit 1

for sha in ${commits}; do
  # (a) Reachable from the upstream default branch, per the upstream API.
  #     compare(default...sha) is "identical" or "behind" with ahead_by 0 exactly
  #     when sha is contained in that branch.
  reach=$(gh api "repos/${UPSTREAM_REPO}/compare/${default_branch}...${sha}" \
    --jq '"\(.status)/\(.ahead_by)"')
  case "${reach}" in
  identical/0 | behind/0) ;;
  *) exit 1 ;;
  esac

  # (b) GitHub-verified signature, with the signer resolved by GitHub.
  # (c) upstream tree SHA, for the commit-object cross-check below.
  meta=$(gh api "repos/${UPSTREAM_REPO}/commits/${sha}" \
    --jq '[.commit.verification.verified, (.author.login // ""), (.commit.tree.sha // "")] | @tsv')
  verified=$(printf '%s' "${meta}" | cut -f1)
  signer=$(printf '%s' "${meta}" | cut -f2)
  upstream_tree=$(printf '%s' "${meta}" | cut -f3)

  [ "${verified}" = "true" ] || exit 1
  [ "${signer}" = "${EXPECTED_SIGNER}" ] || exit 1
  [ -n "${upstream_tree}" ] || exit 1

  # (c) Commit + artifact hash cross-check against this PR's own objects.
  local_tree=$(git rev-parse "${sha}^{tree}")
  [ "${local_tree}" = "${upstream_tree}" ] || exit 1

  upstream_blob=$(gh api "repos/${UPSTREAM_REPO}/contents/${GUARDED_PATH}?ref=${sha}" --jq '.sha')
  local_blob=$(git rev-parse "${sha}:${GUARDED_PATH}")
  [ -n "${upstream_blob}" ] || exit 1
  [ "${upstream_blob}" = "${local_blob}" ] || exit 1
done

exit 0
