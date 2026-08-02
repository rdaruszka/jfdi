# The Harness Abstraction

Agents run as headless subprocesses of a coding-agent CLI. Everything
provider-specific — flags, JSON stream formats, session resumption, hook
injection — lives behind one interface, so pipeline logic never touches it.
This is a hard invariant, and it is what makes "add a provider" a contained,
mechanical task.

Source: [src/harness/types.ts](../../src/harness/types.ts) (the interface),
[claude.ts](../../src/harness/claude.ts), [codex.ts](../../src/harness/codex.ts)
(the implementations), [fake.ts](../../src/harness/fake.ts) (the test double),
[index.ts](../../src/harness/index.ts) (selection).

## The interface

```ts
interface Harness {
  readonly name: string;
  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession;
  spawnInteractive(promptSpec: PromptSpec, options: InteractiveSpawnOptions): Promise<number>;
}

interface PromptSpec { prompt: string }

interface SpawnOptions {
  cwd: string;                 // the ticket's worktree
  logPath?: string;            // raw provider output appended here (jfdi logs)
  continueSessionId?: string;  // continue an earlier session (see below)
}

interface HarnessSession {
  events: AsyncIterable<HarnessEvent>;  // live progress stream
  done: Promise<HarnessResult>;         // never rejects; failures are ok: false
  kill(): void;                         // SIGTERM, then SIGKILL after 5s
}

type HarnessEvent =
  | { type: "text";    text: string }
  | { type: "tool";    name: string; detail?: string }
  | { type: "session"; sessionId: string }   // provider id for continuation
  | { type: "result";  ok: boolean; text: string };

interface HarnessResult { ok: boolean; text: string; exitCode: number; sessionId?: string }
```

Contracts worth knowing:

- **`done` never rejects.** Session failures are data (`ok: false` with the
  failure text), not exceptions — a dead subprocess must not take down the
  coordinator.
- **Sessions report a `sessionId`** the pipeline stores to continue the
  conversation in a later round. **Providers forget sessions**; callers must
  treat a failed continuation as "fall back to one fresh spawn with the full
  prompt," and the pipeline does exactly that.
- **Provider stream lines are untrusted.** A line that doesn't parse into a
  known event shape is simply not an event; raw output still lands in the log
  file for `jfdi logs`.
- `spawnInteractive` hands the terminal to the provider (used by `jfdi init`
  and `jfdi convo`) and resolves with its exit code. `isSystemPrompt: true`
  requests true system-prompt semantics where the provider supports it; others
  approximate it as an initial message.

## Provider implementations

### Claude Code

Headless spawn:

```
claude -p <prompt> --output-format stream-json --verbose --permission-mode bypassPermissions
       [--resume <sessionId>]                 # continuation
       [--settings <cwd>/.jfdi/claude-settings.json]   # when the file exists
```

- Parses the `stream-json` line protocol: assistant text and `tool_use` blocks
  become `text`/`tool` events (with a truncated human-readable detail — file
  path, command, pattern); the `system:init` line and the final `result` line
  carry the session id (a continued session gets a *fresh* id — last one wins);
  the `result` line becomes the `result` event.
- **The settings injection is the provider-specific acceleration**: when
  `.jfdi/claude-settings.json` exists it is passed via `--settings`, wiring a
  PostToolUse hook that formats each edited file
  ([details](../guide/prompts-and-customization.md#the-format-hook)).
- Interactive: `claude <prompt>`, or `claude --append-system-prompt <prompt>`
  when `isSystemPrompt` is set.

### Codex

Headless spawn:

```
codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>
codex exec resume --json --dangerously-bypass-approvals-and-sandbox <threadId> <prompt>   # continuation
```

- Parses the Codex JSON event protocol: `thread.started` carries the thread id
  (the continuation handle), `agent_message` items become `text` events,
  command/MCP/web-search items become `tool` events, `turn.failed`/`error`
  become failure results.
- Codex emits no terminal success line, so the harness synthesizes the `result`
  event from the last agent message on a clean exit.
- No hook system → no settings injection. The format-hook acceleration is
  simply absent: degraded, not broken.
- Interactive: `codex --dangerously-bypass-approvals-and-sandbox <prompt>`;
  `isSystemPrompt` is ignored.

Both implementations share the same shape deliberately: line-by-line stdout
parsing mirrored to the log file, a rolling stderr tail for diagnostics when the
result line never arrives, exit code 127 on a missing executable, and the same
kill semantics. They are near-duplicates by design — the duplication keeps each
provider's quirks local instead of leaking into a shared "provider-generic"
layer that wouldn't be.

### Permissions

JFDI supplies the autonomous-operation flags (`bypassPermissions` /
`--dangerously-bypass-approvals-and-sandbox`) itself; they are not project
configuration, and a legacy `harnessArgs` config key is explicitly rejected.
The safety model is the pipeline around the session — isolated worktrees, the
gate, two reviews, serialized integration — not per-tool-call prompting, which
would make unattended operation impossible.

### The fake harness

Tests use `FakeHarness`: a constructor-injected handler plays the agent
in-process, performing real side effects (writing files, committing, dropping
verdict files) and recording every call for assertions on prompts and
continuation ids. It is not reachable from config — tests construct it
directly. End-to-end tests that exercise real spawning use stub `claude`/`codex`
scripts on `PATH` instead.

## Selection

`config.harness` (`"claude"` | `"codex"`) selects the implementation via an
exhaustive switch in [src/harness/index.ts](../../src/harness/index.ts). One
harness serves the whole instance: every pipeline stage, `jfdi init`, and
`jfdi convo`.

## Adding a provider

1. Extend the `HarnessName` union in [src/config.ts](../../src/config.ts) (and
   its validation message).
2. Implement `Harness` in `src/harness/<name>.ts`: map the provider's headless
   JSON output to `HarnessEvent`s, report a session/thread id for continuation,
   implement `spawnInteractive`, honor `logPath`, never reject `done`.
3. Add the case to `createHarness` and the export in `src/harness/index.ts`.
4. Keep provider-specific accelerations inside the new file; their absence in
   other providers must degrade gracefully, and their presence must not leak
   into pipeline logic.
