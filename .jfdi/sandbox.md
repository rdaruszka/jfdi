# QA Sandbox Contract — JFDI itself

The product under test is JFDI: a CLI that spawns agent sessions and creates git
worktrees. Exercise the **built artifact**, not the source.

## Build

```
pnpm install --frozen-lockfile   # if node_modules is missing
pnpm build                       # emits dist/
```

## Launch & drive

Invoke the CLI as `node <repo>/dist/index.js <command>` (where `<repo>` is this
worktree). Useful commands and expectations:

- `... --help` — usage text, exit 0
- `... init --bare` — scaffolds `.jfdi/` in the *current directory's* repo, exit 0
- `... run "<ticket text>"` — full pipeline with inline streaming; exit 0 on
  pass, 2 on blocked, 1 on failure
- `... status` / `... status --json` — snapshot of the project's `state.json`
  under `$JFDI_HOME/projects/<project-key>/`
- `... logs <ticket-id>` — raw session logs for the latest run
- `... merge <ticket-id>` — approve a ready-to-merge ticket

## Isolation rules (critical — self-hosting)

JFDI-under-test spawns its own agent sessions and creates its own worktrees:

1. **Every scenario runs in a scratch git repo under the OS temp dir**
   (`mktemp -d`), never inside this worktree or any parent git repo — both git
   and Claude Code walk up the directory tree.
2. **Never let the inner JFDI call a real agent CLI.** Put stub `claude` and
   `codex` executables on PATH that replay canned JSON event lines and write the
   verdict file its prompt names (match `/(\/\S+\.verdict\.json)/`). This also
   guards against runaway nested session spawning.
2b. One prompt names no verdict file: the scribe's (`commit-message`), whose
   whole answer is the commit message it prints as its result text. A stub that
   ignores it still works — the pipeline falls back to its own wording — but a
   stub that answers it lets a test assert on real commit subjects.
3. The inner JFDI gets its own `.jfdi/` setup inside the scratch repo (its
   `init --bare` creates it). Never point it at this repo's `.jfdi/`.
4. **Always export `JFDI_HOME` to a scratch directory.** Run state now lives in
   `~/.jfdi/projects/<project-key>/`; without the override, JFDI-under-test
   writes into the real home directory.
5. Configure the scratch repo's git user (`git config user.email/name`) or
   commits will fail.

## Teardown

`rm -rf` the scratch directory and the `JFDI_HOME` directory — between them they
hold everything JFDI-under-test wrote. Verify no stray `claude` or `codex` processes remain
if a test killed a run mid-flight.
