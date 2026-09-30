# .agents/ memory bank

Working memory for this fork. Keep entries short, factual, dated.

## Schema

- `memory.md` — persistent knowledge. Append `## <date> — <topic>` entries; keep decisions and gotchas; never silently delete prior entries.
- `state.md` — always-current status. Rewrite at session start/end with: Goal, Today's progress, Blockers, Next actions.

## Maintenance rules

- Session start: read `state.md`, skim `memory.md` Decisions/Gotchas.
- Session end: rewrite `state.md`; append anything durable to `memory.md`.
- Never delete prior `memory.md` entries — append corrections as new dated entries.
- Keep credentials, tokens, and private URLs out of this directory and git.
