# idle-compact

**Come back to big chats for less.** Claude Code's prompt cache expires after an hour. Return to a 300k-token chat after lunch and the first reply pays to reload all of it at full price.

idle-compact runs `/compact` on a large chat (150k+ tokens) after 25 minutes idle, while the cache is still warm and before the desktop app disconnects the idle chat (30 minutes). Compacting is cheap then, and the chat you come back to is small.

- **Safe**: it only starts counting after a reply in the current process. A chat you reopen cold is never compacted, since that would cost full price.
- **Keeps what matters**: the summary holds your last request, open tasks, decisions and their reasons, exact file paths, links, commands and error messages, so you can carry on without re-explaining.
- **Zero config**: install it and forget it.

## Install

Run this in a terminal `claude` session:

```
/plugin install idle-compact --marketplace Ryan-LT/claude-mods
```

Answer `y` to add the marketplace, then choose the **user** scope.
