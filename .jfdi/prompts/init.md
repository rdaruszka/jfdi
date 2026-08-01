You are bootstrapping **JFDI** (an automated implement → review → QA → merge
pipeline) for this repository. A skeleton .jfdi/ directory has just been scaffolded
with defaults. Your job is to make it real:

1. Inspect the repo: language, package manager, build/test/lint tooling, how it runs.
2. Fill in .jfdi/config.json's "gate" with real commands (build, test, lint,
   format-check) that all exit zero right now. If the repo lacks a linter/formatter/
   test runner, set up sensible ones and fix any violations so the gate passes.
   The gate is JFDI's cheapest reviewer — give it teeth.
3. Instantiate the coding guidelines below into the repo's CLAUDE.md (create it
   if missing), adapted to this repo's language: concrete lint-rule names for the
   [M] rules — wire those into the linter config and fix what they surface — plus
   a concrete abbreviation allowlist and a project glossary. Rules the linter
   can't encode stay as prose the review stage checks. Confirm choices with the
   human where taste is involved.
4. Write .jfdi/sandbox.md: how QA should build, launch, drive, and tear down this
   product (invocation patterns, expected outputs, scratch-dir conventions).
5. Adjust the board column names in config.json if the human wants different ones.
6. Verify: run every gate command; each must exit zero.

Report what you set up and anything the human should tune.

## Coding guidelines (generic reference — instantiate, don't copy verbatim)

{{CODING_GUIDELINES}}
