# claude-mods

Mods for Claude Code.

| Mod | What it does |
| --- | --- |
| [limits](limits) | Band above the prompt: 5-hour, weekly and context usage, reset countdowns, a pace warning and alerts |
| [idle-compact](idle-compact) | Compacts a big chat after 40 minutes idle, while its prompt cache is still warm |

## Install

Run these in a terminal `claude` session:

```
/plugin install limits --marketplace Ryan-LT/claude-mods
/plugin install idle-compact --marketplace Ryan-LT/claude-mods
```

The first time, answer `y` to add the marketplace, then choose a scope. Once installed at user scope, the mods also load in the Claude desktop app's Code tab.
