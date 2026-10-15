# limits

A Claude Code mod that keeps your usage limits in view, in a band above the prompt:

- **5-hour** and **Weekly** usage, each with a bar, the percent used and a countdown to its reset
- **Context**: how full this session's context window is
- The percent turns red when your current pace would use up the limit before it resets
- A toast at 75%, 90% and 100%
- A refresh button. While you're idle it also refreshes on its own every 2 minutes with a one-token Haiku request, which all open sessions share.

## Install

Run this in a terminal `claude` session:

```
/plugin install limits --marketplace Ryan-LT/claude-mods
```

Answer `y` to add the marketplace, then choose a scope. Once installed at user scope, it also shows in the Claude desktop app's Code tab.

## Develop

```
claude --plugin-dir ./
claude plugin validate .
claude plugin test .
```
