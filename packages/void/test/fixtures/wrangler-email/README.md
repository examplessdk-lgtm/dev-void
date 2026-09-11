# wrangler email prose fixtures

Verbatim stdout / stderr / exit code of the pinned wrangler's `email` command group
and `whoami --json`, captured READ-ONLY against a real account, one directory per
wrangler version. `src/cli/email-cloudflare.ts` pins its prose parsers to these
(`WRANGLER_EMAIL_PROSE_VERSION`); `test/unit/wrangler-pin.test.ts` asserts that constant
equals the installed wrangler's version, so a catalog move fails that test until the prose is
re-captured into a new `<version>/` directory and the constant is moved.

Capture (all read-only; `WRANGLER_SEND_METRICS=false`, account pinned via
`CLOUDFLARE_ACCOUNT_ID`):

```
node <wrangler-dist/cli.js> whoami --json
node <wrangler-dist/cli.js> email routing settings <zone>
node <wrangler-dist/cli.js> email routing rules list <zone>
node <wrangler-dist/cli.js> email sending settings <domain>
node <wrangler-dist/cli.js> email routing settings <not-a-zone>       # exit 1
node <wrangler-dist/cli.js> email sending settings <not-onboarded>    # exit 1
```

Personal identifiers in `whoami.stdout` (email, personal account ids/names) and the
`~/.wrangler/logs/...` path in the stderr captures are replaced with placeholders;
every other byte is as printed. Every `wrangler email` run prints an "open beta
command" warning on stderr — the parsers read stdout only.
