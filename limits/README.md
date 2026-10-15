# limits

**See your Claude usage limits before they bite.** An always-on band above the Claude Code prompt:

![limits band](docs/band.webp)

- **5-hour** and **Weekly**: a bar, the percent used, and a countdown to the reset. The tick on each bar marks where an even pace would be by now.
- **Pace warning**: the percent turns **red** when your current rate would use up the limit before it resets. You find out on Tuesday, not when you're blocked on Thursday.
- **Context**: how full this chat's context window is (`89.1k/1M`).
- **Alerts**: a toast at 75%, 90% and 100%.
- **The real numbers**: every 2 minutes (or when you press refresh) it asks Anthropic for the same figures claude.ai's usage page shows, using your Claude login. No model request, so no tokens, and all open sessions share one ask, so 10 open chats still make only one request.
- Works in the terminal and the desktop app.

## Install

Run this in a terminal `claude` session:

```
/plugin install limits --marketplace Ryan-LT/claude-mods
```

Answer `y` to add the marketplace, then choose the **user** scope.

## Develop

```
claude --plugin-dir ./limits
claude plugin test ./limits
```
