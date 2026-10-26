# Project delivery conventions

## Local deployment

The installed `codex-webui` launcher must run the canonical checkout at
`/home/hashed/git/codex-webui` on the `main` branch. Never point it at a feature, fix, planning, or
temporary worktree.

After a pull request is merged into `main`, delivery is not complete until the local canonical
checkout has been fetched and rebased onto `origin/main`, is clean, and resolves to the same commit
as `origin/main`. Verify that `/home/hashed/bin/codex-webui` still targets the canonical checkout and
run a local startup/health smoke test. Keep startup independent of network availability: deployment
updates the checkout after merge; the launcher itself must not fetch or pull on every invocation.
