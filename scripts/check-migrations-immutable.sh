#!/usr/bin/env bash
# Fails when a migration that already exists at <base> is edited or deleted at <head> (default HEAD).
#
# A migration that exists on main has been applied by a deploy, and `migrate` verifies the checksum of every applied
# migration on every run (MigrationChecksumError, never repaired): an edited one fails the next deploy's migration,
# after the merge. This check fails the merge instead. Change the schema with the next free number
# (packages/db/README.md, section 5).
# CI (.github/workflows/ci.yml, quality job) runs this against a pull request's base and against the previous main.
#
#   scripts/check-migrations-immutable.sh origin/main
set -euo pipefail

base="${1:?usage: scripts/check-migrations-immutable.sh <base-commit> [head-commit]}"
head="${2:-HEAD}"
dir="packages/db/migrations"

git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || { echo "::error::unknown base commit ${base}"; exit 2; }
git rev-parse --verify --quiet "${head}^{commit}" >/dev/null || { echo "::error::unknown head commit ${head}"; exit 2; }

checked=0
problems=0
while IFS= read -r file; do
  [[ "${file}" == *.sql ]] || continue
  checked=$((checked + 1))
  before="$(git rev-parse "${base}:${file}")"
  if ! after="$(git rev-parse --verify --quiet "${head}:${file}")"; then
    echo "::error file=${file}::${file} exists at the base and was deleted: a migration that has been applied is never removed."
    problems=$((problems + 1))
  elif [ "${before}" != "${after}" ]; then
    echo "::error file=${file}::${file} exists at the base and was edited: add a new migration with the next free number instead."
    problems=$((problems + 1))
  fi
done < <(git ls-tree --name-only "${base}" -- "${dir}/")

if [ "${checked}" -eq 0 ]; then
  echo "::error::no migrations found under ${dir} at ${base}"
  exit 2
fi
if [ "${problems}" -gt 0 ]; then
  exit 1
fi
echo "${checked} applied migrations unchanged since ${base}."
