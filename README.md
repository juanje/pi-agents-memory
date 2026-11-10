# pi-agents-memory

Pi extension for [agents-memory](https://github.com/juanje/agents-memory) —
cross-session persistent memory for AI coding agents.

When you open a project, the agent knows what it is, what you did last time,
your standards for that stack, and how your team works — without you repeating
anything.

## Install

```bash
pi install npm:pi-agents-memory
```

Requires an [agents-memory](https://github.com/juanje/agents-memory) instance
at `~/agents-memory/` (or `$AGENT_MEMORY_DIR`).

## What it does

### Session start

Reads your project memory and injects it as context:

- Project index, latest sessions, open threads
- Stack standards (python, typescript, etc.)
- Team conventions
- Global preferences

New projects are auto-detected and scaffolded.

### Auto-save

Extracts memory from the conversation automatically:

| Trigger | Event | Behavior |
|---------|-------|----------|
| Session end | `session_shutdown` (quit) | Always saves |
| Compaction | `session_compact` | Always saves |
| Periodic | `agent_end` | Only when threshold reached (default: 10) |

The threshold is configurable in `~/agents-memory/config.json`:

```json
{"auto_save_threshold": 10}
```

### Background consolidation

At session start, checks if a consolidation cycle is due and launches it
in the background via `pi -p`.

## Configuration

The extension reads `~/agents-memory/config.json` (shared with Claude Code
and Cursor hooks). No Pi-specific configuration needed.

Projects with a `.skip` file in their memory directory are excluded.

## Requirements

- [agents-memory](https://github.com/juanje/agents-memory) instance
- `pi` CLI available in PATH (for auto-save and consolidation subprocesses)

## License

MIT

## Author

Juanje Ojeda
