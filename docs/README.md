# JFDI Documentation

JFDI is a CLI harness around coding-agent CLIs: hand it a ticket and it runs
implement → review → QA in an isolated git worktree, then merges; point it at a
Kanban board and it does that continuously, several tickets at a time. The
[project README](../README.md) has the elevator pitch and quick start.

## Using JFDI

- **[Getting Started](getting-started.md)** — install, `jfdi init`, first
  ticket, first board.
- **[Board & Tickets](guide/board-and-tickets.md)** — the Obsidian-Kanban board,
  columns and roles, cards and wikilinks, ticket notes, the agent-proposal
  Inbox, safe co-editing, vault symlinks.
- **[The Pipeline](guide/pipeline.md)** — stages, the mechanical gate, verdicts,
  feedback rounds and session continuation, escalation, resuming interrupted
  runs.
- **[Integration & Merging](guide/integration.md)** — serialized integration,
  conflict resolution, the complicated-merge valve, `auto` vs `on-approval`,
  approving and hand-merge detection.
- **[Configuration](guide/configuration.md)** — every `.jfdi/config.json`
  field, the other files under `.jfdi/`, environment variables.
- **[Prompts & Customization](guide/prompts-and-customization.md)** — editing
  stage prompts, the QA sandbox contract, the format hook, conversational init.
- **[CLI Reference](guide/cli.md)** — every command, flag, and exit code.

## Understanding & extending JFDI

- **[Architecture Overview](architecture/overview.md)** — components, the life
  of a run, hard invariants, trust boundaries, extension seams.
- **[The Harness Abstraction](architecture/harness.md)** — the provider
  interface, the Claude Code and Codex implementations, adding a provider.
- **[Events & State](architecture/events-and-state.md)** — the append-only
  event stream, derived state, the state directory, multi-process coordination.
- **[Development Guide](development.md)** — toolchain, tests, the half-app
  fixture and playground, self-hosting workflow.

## Product content (shipped to target projects)

These are not only documentation *about* JFDI: the generic guidelines and
ticket format are product content compiled into the CLI, while the enforcement
document records their design rationale.

- **[Coding Guidelines](coding-guidelines.md)** — the language-agnostic rules,
  with enforcement tiers and check questions (compiled into the tool via
  `pnpm sync:guidelines`).
- **[Ticket Format](ticket-format.md)** — the authoritative card and ticket
  writing contract, shipped into target projects as `.jfdi/ticket-format.md`.
- **[Agent Enforcement](agent-enforcement.md)** — the enforcement design those
  guidelines implement.

## Glossary

One name per concept — these terms are used exactly, here and in the code:

| Term | Meaning |
|---|---|
| **board** | `.jfdi/board.md`, the Obsidian-Kanban file; its columns hold cards |
| **card** | one line on the board; a pointer to work |
| **ticket** | the markdown note in `.jfdi/tickets/` a card wikilinks to |
| **run** | one ticket's trip through the pipeline |
| **state directory** | `~/.jfdi/projects/<project-key>/` — one project's run state |
| **stage** | one agent session within a run: Implementation, Code Review, QA |
| **scribe** | the cheap, read-only session that writes each commit message; plumbing, not a stage |
| **comment** | one entry in a ticket's `## Comments` trail: a pipeline *transition* or an agent *decision* |
| **gate** | the mechanical check (build/test/lint); all commands must exit zero |
| **round** | one feedback cycle: fix → gate → reviews |
| **sign-off** | a review stage's approval, bound to the pipeline's handoff commit |
| **integration** | the coordinator-owned merge → gate → land step; globally serialized |
| **coordinator** | the long-running process that watches the board and dispatches runs |
| **harness** | the agent-session abstraction; Claude Code and Codex are implementations |
| **worktree** | the isolated git checkout (branch `jfdi/<ticket-id>`) a run works in |
| **resume** | a re-dispatch that continues an interrupted run's partial work (run-level) |
| **continuation** | re-entering a stage's previous agent session in a later round (session-level) |
| **pause** | the tool-wide hold on agent sessions while the provider is down; no card is ever blocked for it |
| **observation** | an out-of-scope issue a stage reports in its verdict; never fixed inline |
| **inbox** | the board column where observations land as proposals; agents propose, humans promote |
