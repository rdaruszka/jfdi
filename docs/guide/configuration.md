# Configuration Reference

All project configuration lives in `.jfdi/config.json`, versioned with your
repo. Every field is optional **except [`stages`](#stages)** — a missing file
means all defaults, but a file that exists must carry a complete `stages`
section. A config with the wrong *types* is a hard error with a message naming
the field.

A complete example (this is also what `jfdi init` writes, minus the gate, which
init fills in for your repo):

```jsonc
{
  "board": {
    "path": ".jfdi/board.md",
    "columns": {
      "begin": "Ready",
      "inProgress": "In Progress",
      "done": "Done",
      "blocked": "Blocked",
      "readyToMerge": "Ready to Merge",
      "inbox": "Inbox"
    }
  },
  "ticketsDirectory": ".jfdi/tickets",
  "gate": [
    { "name": "build", "command": "pnpm build" },
    { "name": "test",  "command": "pnpm test" },
    { "name": "lint",  "command": "pnpm lint" }
  ],
  "pipeline": { "maxRounds": 3 },
  "integration": {
    "targetBranch": "main",
    "mode": "on-approval",
    "remote": { "fetchBefore": false, "pushAfter": false }
  },
  "permissions": { "mode": "auto" },
  "maxConcurrent": 2,
  "stages": {
    "implementation": { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
    "code-review":    { "harness": "codex",  "model": "gpt-5.6-sol",   "effort": "high" },
    "qa":             { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
    "integration":    { "harness": "claude", "model": "claude-opus-4-8", "effort": "medium" },
    "commit-message": { "harness": "claude", "model": "claude-sonnet-5" }
  }
}
```

## Field reference

### `board`

| Field | Type | Default | Notes |
|---|---|---|---|
| `board.path` | string | `.jfdi/board.md` | Relative to the repo root. May be (or point through) a symlink into an Obsidian vault — writes follow the link. |
| `board.columns.begin` | string | `Ready` | Cards here are dispatched, top first. Never auto-created — the heading must exist on the board. |
| `board.columns.inProgress` | string | `In Progress` | Where dispatched cards sit while running. |
| `board.columns.done` | string | `Done` | Merged cards land here, checked off. |
| `board.columns.blocked` | string | `Blocked` | Escalations, exhausted rounds, and failed integrations, including exhausted remote git retries. Agent-provider failures pause the tool instead. |
| `board.columns.readyToMerge` | string | `Ready to Merge` | Only used when `integration.mode` is `on-approval`. |
| `board.columns.inbox` | string | `Inbox` | Agent observation proposals. Never dispatched from. |

Column names are matched against board headings by exact string equality —
rename in both places or neither. See
[Board & Tickets](board-and-tickets.md#columns-and-roles) for what each role
does.

### `ticketsDirectory`

| Type | Default |
|---|---|
| string | `.jfdi/tickets` |

The only directory card `[[wikilinks]]` resolve against. Like the board, commonly
symlinked into a vault.

### `gate`

| Type | Default |
|---|---|
| array of `{ "name": string, "command": string }` | `[]` |

The **mechanical gate**: an ordered list of shell commands that must all exit
zero. Commands run sequentially via `/bin/sh -c` in the ticket's worktree,
stopping at the first failure; the failing command's output becomes agent
feedback for the next round. See [The Pipeline](pipeline.md#the-mechanical-gate)
for when it runs.

An empty gate always passes — legal, but it means "done" is whatever the agent
says it is. Give the gate teeth: build, test, lint, format-check. `jfdi init`
sets this up for your repo, and encoding standards into the gate instead of
review prose is the core system value — the gate is the cheapest reviewer.
Checks too large for a clear one-line command belong in `.jfdi/scripts/`, with
the gate entry invoking the script (for example,
`sh .jfdi/scripts/check-docs-sync.sh`).

### `pipeline`

| Field | Type | Default | Constraint |
|---|---|---|---|
| `pipeline.maxRounds` | integer | `3` | ≥ 1 |

The feedback-round cap per run. On exhaustion the card moves to Blocked with the
round history in the ticket note. Gate failures after Implementation do not
consume a round — they feed back into the same session, up to 10 fix sessions
per round; rounds count trips through the review stages.

### `integration`

| Field | Type | Default | Values |
|---|---|---|---|
| `integration.targetBranch` | string | `main` | Any local branch. Never assumed — set it if your default branch differs. |
| `integration.mode` | string | `on-approval` | `"auto"` or `"on-approval"` |
| `integration.remote.fetchBefore` | boolean | `false` | Fetch the target branch before merging and fast-forward a behind local target. |
| `integration.remote.pushAfter` | boolean | `false` | Push the target branch after its landing merge commit is created locally. |

`auto` merges a passing pipeline immediately; `on-approval` parks it in Ready to
Merge for your sign-off. The optional `remote` block is disabled by default. If
either flag is enabled, JFDI uses the target branch's configured upstream remote,
falling back to `origin`; a repository with no configured git remotes keeps the
local-only behavior. See [Integration & Merging](integration.md).

### `permissions`

| Field | Type | Default | Values |
|---|---|---|---|
| `permissions.mode` | string | `auto` | `"auto"` or `"bypass"` |

The **permission mode** is one instance-wide policy for every headless,
continued, and interactive agent session. `auto` is the safer default for
unattended work; `bypass` is an opt-in for hosts whose isolation is managed
outside JFDI.

| JFDI mode | Claude Code (headless) | Claude Code (interactive) | Codex |
|---|---|---|---|
| `auto` | `--permission-mode acceptEdits --allowedTools Bash` | `--permission-mode auto` | `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true` |
| `bypass` | `--permission-mode bypassPermissions` | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

Codex's `workspace-write` sandbox keeps filesystem writes inside the worktree.
Network access is normally off in that sandbox, so JFDI enables it to keep
unattended sessions able to fetch and resolve packages. The sandbox is selected
via `-c sandbox_mode=` rather than the equivalent `--sandbox` flag because
`codex exec resume` (continuations) rejects `--sandbox`; the `-c` spelling is
accepted by every spawn form. JFDI does not use the deprecated `--full-auto`
compatibility flag.

Claude Code's own `auto` mode is interactive-only: its classifier escalates
blocked actions to a human, and a headless session has no one to ask, so it
denies every write — the worktree included. Headless and continued sessions
therefore run `acceptEdits` (edits auto-approved, confined to the session's
working directories) with the Bash tool allowed, the documented spelling for an
autonomous headless session that can still run builds, tests, and git;
interactive `jfdi init` keeps `auto`, where the human at the terminal answers
the classifier.

### `maxConcurrent`

| Type | Default | Constraint |
|---|---|---|
| integer | `2` | ≥ 1 |

How many ticket pipelines the coordinator runs at once. Dispatch order is board
order (top of the begin column first); integration is always serialized
regardless of this setting.

### `stages`

**Required.** One entry per stage — `implementation`, `code-review`, `qa`,
`integration` — plus `commit-message` for the **scribe**, choosing the agent
each one runs. The scribe is not a stage: it is the read-only, single-shot
session that writes every commit message
([how](pipeline.md#commits-and-the-scribe)). It is keyed here because it spawns
a session, and this is where session selections live.

| Field | Type | Required | Values |
|---|---|---|---|
| `harness` | string | yes | `"claude"` or `"codex"` |
| `model` | string | no | Provider-native. Anything the CLI accepts: an alias (`opus`) or a full id (`claude-opus-4-8`, `gpt-5.6-sol`). |
| `effort` | string | no | Provider-native. Claude Code: `low`, `medium`, `high`, `xhigh`, `max`. Codex: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |

There is **no global harness and no provider-neutral model vocabulary**: model
strings go to the CLI verbatim, and the provider is the authority on what
exists — an unknown model surfaces as a failed session. An `effort` the chosen
harness does not accept is rejected at load, naming the stage and the accepted
list, so a typo costs a startup error rather than a round.

Omitting `model` or `effort` means **pass no flag**: the provider's own default.
A value is never inherited from another stage or from the scaffolded example, so
naming only a harness can't pair one provider with another's model.

The selection is fixed per stage, which is what makes
[continuations](pipeline.md#fresh-sessions-vs-continuations) safe — a session id is
only meaningful to the harness that minted it, and a stage always re-enters its
own. Each session's configured harness, model and effort are recorded on its
`stage_start` event. The provider-confirmed model, when reported, is recorded on
`stage_end` and in the run's usage rows; otherwise those rows label the
configured model as a fallback.

`jfdi init` scaffolds the mix in the example above. Its two deliberate choices:

- **Code review runs on a different provider from implementation.** A reviewer
  that isn't the author's own model doesn't share the author's blind spots.
  The consequence is stated plainly: with only one provider's CLI installed, a
  scaffolded project fails at code-review. The failure names the missing binary
  and points at `stages.code-review` — change that entry, or install the CLI.
- **Integration runs a strong model at medium effort.** It only spawns on
  merge conflicts, so the setting prices conflict resolution alone: rare
  enough that cost is negligible, and its output lands directly on the target
  branch where the gate cannot catch silently dropped logic.
- **The scribe runs a cheap model.** Turning a diff and a summary the pipeline
  already assembled into prose is a small task, and it runs after every
  code-producing session — the one selection where volume, not stakes, sets the
  price. It names no `effort` at all.

Interactive init is selected independently of these stage entries. `jfdi init`
uses `--harness` (`claude` or `codex`), `--model`, and optional `--effort`, with
defaults of Claude, `claude-fable-5`, and the provider's default effort. The
instance-wide `permissions.mode` applies when the config loads; otherwise init
warns and uses the default `auto` mode so the setup session can repair it. There
is deliberately no `stages.init` entry: init must work before a new user has
config to edit.

Both selected CLIs must be on your `PATH`. Beyond model, effort, and the
provider-neutral permission mode, provider-specific flags are supplied by JFDI
itself and are not configurable; a legacy `harnessArgs` key is rejected with an
explicit error.

> **Upgrading:** `stages` replaced a single top-level `harness` key, and there
> is no migration. A config still carrying `harness`, missing `stages`, or
> missing any of the five entries — `commit-message` included — is rejected at
> load with the block to paste in. Update `.jfdi/config.json` by hand.

## Legacy key spellings

Configs created before the canonical schema may use these spellings:

| Legacy | Canonical |
|---|---|
| `ticketsDir` | `ticketsDirectory` |
| `gate[].cmd` | `gate[].command` |
| `pipeline.max_rounds` | `pipeline.maxRounds` |
| `integration.target_branch` | `integration.targetBranch` |
| `integration.remote.fetch_before` | `integration.remote.fetchBefore` |
| `integration.remote.push_after` | `integration.remote.pushAfter` |
| `max_concurrent` | `maxConcurrent` |

JFDI continues to accept these keys. Any command that loads a config containing
one prints a single notice suggesting `jfdi update-config`; the notice is a
nudge, not an error.

Run `jfdi update-config` from anywhere inside the repository to rename every
legacy key mechanically. It works on the raw JSON so keys outside JFDI's schema
survive, reports each rename, and replaces the file atomically. A second run is
a successful no-op. Invalid JSON cannot be migrated: the command exits non-zero
with the file and parse error and leaves the file untouched. This key-only
migration does not synthesize the required `stages` section described above.

## Other files under `.jfdi/`

`config.json` is one of several versioned setup files; the rest have their own
pages:

| File | Purpose | Docs |
|---|---|---|
| `prompts/*.md` | The eight unattended prompt templates. On disk, editable, authoritative. | [Prompts & Customization](prompts-and-customization.md) |
| `sandbox.md` | The QA sandbox contract — how to build, launch, drive, and tear down your product. | [Prompts & Customization](prompts-and-customization.md#the-sandbox-contract) |
| `ticket-format.md` | Required reading for agents that create or change cards and tickets. | [Ticket Format](../ticket-format.md) |
| `claude-settings.json` | Settings injected into JFDI-spawned Claude Code sessions (wires the format hook). | [Prompts & Customization](prompts-and-customization.md#the-format-hook) |
| `hooks/format.sh` | Per-file format hook invoked after each edit in Claude sessions. | [Prompts & Customization](prompts-and-customization.md#the-format-hook) |
| `.gitignore` | Scaffold-owned; keeps `worktrees/`, `board.md`, and `tickets` out of version control. | — |
| `board.md`, `tickets/` | Work tracking — deliberately **not** versioned. | [Board & Tickets](board-and-tickets.md) |
| `worktrees/` | Per-ticket isolated checkouts. Runtime state, gitignored. | [The Pipeline](pipeline.md) |

## Environment

| Variable | Effect |
|---|---|
| `JFDI_HOME` | Overrides `~/.jfdi` as the base for all run state (`projects/<project-key>/`). Set it in tests and QA sandboxes so nested runs never touch your real state. Use an absolute path. |

Run state — event stream, state snapshot, per-run logs and reports — lives
*outside* the project, under `~/.jfdi/projects/<project-key>/`, where
`<project-key>` is the project root's absolute path with separators flattened to
dashes. See [Events & State](../architecture/events-and-state.md).
