# check

**"Someone replied, what do I do now?" in one command.** Give `/check` a GitHub issue, PR or comment link, a Slack thread, an email, or pasted text (or nothing, and it uses your clipboard). Claude reads the whole thread, the linked PRs and the code it touches, and answers with:

- **TL;DR**: what's going on and what to do.
- **The ask**: who wants what from you, quoted, with the link.
- **Where it stands**: what's done, broken or blocked, with links and `file:line`.
- **Next step**: numbered, and which ones Claude can do right now.
- **Draft reply**: ready to paste, in the thread's language and tone.

It only reads. Posting, sending, pushing or merging waits for your yes.

```
/check https://github.com/owner/repo/issues/123#issuecomment-456
```

Works best with the `gh` CLI signed in, and the Slack or Gmail connectors when you check those links. With no argument it reads the clipboard via `pbpaste` (macOS).

## Install

Run this in a terminal `claude` session:

```
/plugin install check --marketplace Ryan-LT/claude-mods
```

Answer `y` to add the marketplace, then choose the **user** scope.
