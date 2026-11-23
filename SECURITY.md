# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

1. Go to the [Security tab](https://github.com/moabbas7/holdline/security) of this repository.
2. Click **Report a vulnerability** ([direct link](https://github.com/moabbas7/holdline/security/advisories/new)).
3. Describe the issue, how to reproduce it, and what an attacker could do with it.

You'll get a reply as soon as possible. Once a fix is ready, it is released and the advisory is published, crediting you unless you prefer otherwise.

## What counts

holdline runs locally, reads your project and, when configured, a local database and a local dev server. Examples of issues we want to hear about:

- holdline writing to a database, or connecting to a non-local host it shouldn't;
- connection strings, passwords, tokens or auth headers ending up in output, logs, reports or snapshots;
- project content (check output, console errors, file contents) being able to inject instructions into what the Claude Code hooks send to the agent;
- rollback or snapshots deleting or overwriting files outside what they should restore;
- the HTML report running scripts or loading external resources.

## Supported versions

Fixes are made on `main`. holdline is installed from GitHub, so update with `npm install -D github:moabbas7/holdline` to get them.
