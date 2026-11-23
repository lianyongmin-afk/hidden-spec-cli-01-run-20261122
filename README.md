# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lianyongmin-afk/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lianyongmin-afk/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org)
[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files.
Built for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
one patch tool for every AI edit format.

## Formats

- **unified diff** — `diff --git` sections and bare `---`/`+++` pairs, hunks matched
  at the position nearest the hunk header (wrong line numbers tolerated),
  `\ No newline at end of file` honoured, create / delete / rename supported.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  path taken from the nearest line above the block, create when the old side
  is empty, `ambiguous` when the old text occurs more than once.
- **V4A patches** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` /
  `*** Update File:` / `*** Move to:` / `@@ anchor` chunks / `*** End of File` /
  `*** End Patch`, with a cursor that walks the file chunk by chunk.
- **JSON edits** — one JSON array, or JSON Lines, of `create` / `str_replace` /
  `insert` tool-call objects, CRLF aware.

## Matching

Old lines are found at the first of three tiers that matches: exact (tier 0),
ignoring trailing spaces and tabs (tier 1), ignoring leading and trailing
spaces and tabs (tier 2, with new lines re-indented to the file's indent).
`--strict` keeps tier 0 only.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-` / absent for standard input. `--check` reports
what would change without writing anything. Every file is changed or nothing
is: a failed edit is reported and no file is written. See `SPEC.md`, the whole
contract.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as issued.
- `check.ts` — run the public practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.
