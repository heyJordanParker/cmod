# Facts

- Claude Code refuses an `$.http.fetch` answer over 4 MiB, as `refused: body of <n> bytes is over the 4194304-byte limit`, and the cmod plugin reaches `cmod serve` only through `$.http.fetch`. So `connectRpc` in `src/runtime/rpc.ts` polls with `?chars=<pollChars>`, and `rpcRoutes` answers that poll with at most `pollChars` characters, sending a larger message as `$/part` pieces the client joins. A poll without `chars`, from a released core, gets every waiting message at once, as before.
