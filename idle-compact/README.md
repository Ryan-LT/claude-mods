# idle-compact

A Claude Code mod that runs `/compact` on a large chat (150k+ tokens) once it has been idle for 40 minutes. At that point the prompt cache (1 hour) is still warm, so compacting is cheap, and when you come back later the chat is small.

- It only starts counting after a reply in the current process, so a chat reopened cold is never compacted at full price.
- The summary keeps your last request, open tasks, decisions and their reasons, file paths, links, commands and error messages.

## Install

Run this in a terminal `claude` session:

```
/plugin install idle-compact --marketplace Ryan-LT/claude-mods
```
