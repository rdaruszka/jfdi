// GENERATED from docs/ticket-format.md — do not edit by hand.
// Edit the doc, then run: pnpm sync:guidelines
// (src/ticket-format.test.ts fails the gate if the two drift.)

/**
 * The ticket-writing contract JFDI ships with, compiled in so the installed CLI
 * carries it. Scaffolded as .jfdi/ticket-format.md for agents and humans who
 * create cards and tickets in a target project.
 */
export const TICKET_FORMAT = `# Ticket Format

Read this file before creating or changing a JFDI card or ticket. A ticket
describes one pipeline run in terms another person can verify; it does not
prescribe the implementation.

## Cards

Write exactly one card per line in \`.jfdi/board.md\`:

\`\`\`markdown
- [ ] Add category filtering to the transaction list [[filter-by-category]]
\`\`\`

The \`[[wikilink]]\` resolves only against the configured tickets directory
(\`.jfdi/tickets/\` by default), never elsewhere in the project or an Obsidian
vault. Its target is the ticket id: \`[[filter-by-category]]\` names
\`.jfdi/tickets/filter-by-category.md\`, runs on branch
\`jfdi/filter-by-category\`, and uses the same id for its worktree and run state.
Use a filename-safe, stable kebab-case id.

The configured begin column (\`Ready\` by default) dispatches work. Only a human
promotes a card into that column. Put drafts and directly requested ticket
proposals in a non-role column such as \`Drafts\` (create that heading if needed).
Do not add new cards directly to In Progress, Done, Blocked, Ready to Merge, or
Inbox. The inbox is reserved for observations that pipeline stages report
through the coordinator.

### When a note is not needed

A trivial one-line task may be a bare card with no wikilink:

\`\`\`markdown
- [ ] Add a --version flag
\`\`\`

For a bare card, that one line is the whole spec. Use a wikilinked ticket for
anything that needs acceptance criteria, context, dependencies, or wording that
may change: editing a bare card changes its generated ticket id.

## Ticket anatomy

A conformant ticket has an H1 title, a short description, and acceptance
criteria:

\`\`\`markdown
---
mode: ask
blocked-by:
  - "[[store-categories]]"
blocks:
  - "[[category-summary]]"
---

# Filter transactions by category

People reviewing a long transaction list need to focus on one spending
category without paging through unrelated entries.

## Acceptance criteria

- A user can list only transactions in a selected category.
- Category matching is case-insensitive.

## Technical context

- The existing command-line interface must remain backward compatible.
\`\`\`

The parts are:

- **Frontmatter (optional).** JFDI reads \`mode: ask\` as a lower escalation
  threshold. \`blocks\` and \`blocked-by\` are lists of ticket wikilinks;
  \`blocked-by\` gates dispatch until those tickets are in the done column, while
  \`blocks\` is its human-facing inverse and does not gate. Those wikilinks have
  the same tickets-directory-only scope as card links. JFDI preserves every
  other frontmatter key but ignores it.
- **H1 title.** One \`#\` heading states the user-facing outcome.
- **Description.** Everything after the H1 and before the first JFDI-owned
  section is the description passed to stages. Your own \`##\` subsections,
  including Acceptance criteria and optional Technical context, are part of
  it.
- **\`## Questions\` and \`## Comments\`.** These sections are JFDI-owned,
  append-only run records. Ticket-writing agents must never create, edit, or
  add prose to them. Never put specification material below either heading:
  it is outside the description and will not reach a stage prompt. JFDI creates
  these sections when a run needs them.

## Writing guidance

Keep the prose before Acceptance criteria to one short plain-language
paragraph, or two at most. Explain who needs the change and what outcome they
need. Acceptance criteria describe observable, user-facing behavior that a
person who did not write the ticket can verify. They do not prescribe classes,
functions, CSS values, file names, or another implementation.

Use an optional \`## Technical context\` section only for genuine constraints:
compatibility requirements, protocols, externally fixed interfaces, or a
known reproduction environment. Do not use it to design the solution in
advance.

Good:

\`\`\`markdown
## Acceptance criteria

- On a narrow screen, the checkout action remains visible without horizontal scrolling.
\`\`\`

Bad:

\`\`\`markdown
## Acceptance criteria

- Add a \`.checkout-button\` class with \`position: fixed\` and \`height: 48px\`.
\`\`\`

The good criterion states what a user can observe. The bad criterion dictates
one solution and can pass while the user-facing problem remains.

## Ready-for-work checklist

Before a human promotes the card to the begin column, confirm:

- The ticket is scoped to one pipeline run, with unrelated work split out.
- Its card is one line and its wikilink resolves to the note in the configured
  tickets directory.
- The note has an H1 title, one or at most two short description paragraphs,
  and acceptance criteria.
- Someone who did not write the ticket can test every acceptance criterion by
  observing the product rather than inspecting the implementation.
- Any Technical context items are real constraints, not proposed solutions.
- A bug ticket names how to reproduce the bug, including the triggering input
  or action and the incorrect observable result.
- No ticket-authored content appears in \`## Questions\`, \`## Comments\`, or below
  either section.
`;
