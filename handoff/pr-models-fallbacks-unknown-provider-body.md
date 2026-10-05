## What Problem This Solves

Fixes: `openclaw models fallbacks add` and `openclaw models image-fallbacks add` save a model whose provider doesn't exist, such as the typo `anthropc/...`. `openclaw models set` already refuses the same input: it exits 1 and leaves config unchanged. The fallback commands skip that check, so the typo is written to `agents.defaults.model.fallbacks` with exit 0. The mistake stays hidden until failover actually needs that fallback, or until `openclaw doctor` reports it as an unknown provider.

## User Impact

User impact: someone adding a backup model can no longer mistype the provider and get "Updated config" for a fallback that can never resolve. Both commands now reject an unknown provider with the same message `models set` uses, and config is left untouched. Known providers keep working, including providers without a local catalog (for example `ollama/...`) and models missing from a known provider's catalog.

## Why This Change Was Made

Fallback add now validates input the same way `models set` already does, as described in `docs/cli/models.md`. The check lives in one helper, `requireKnownModelProvider` in `src/commands/models/shared.ts`. It is extracted unchanged from `updateDefaultModelPrimaryConfig`, and `addFallbackCommand` now calls it too, which covers both `fallbacks` and `image-fallbacks`. The error text is the same. The check runs inside the existing config transform before any write, matching `models set`. The docs line that lists which commands refuse unknown providers now includes the two fallback add commands.

Scope notes:

- The check is exactly the one `models set` uses (`inspectModelReference`). Fallbacks therefore accept and reject the same providers `models set` does.
- `models aliases add` is deliberately unchanged. An earlier revision of this branch applied the check there too, but aliases may target providers that a plugin declares only as runtime hook aliases, and `src/commands/models/model-selection.runtime.test.ts` keeps those working. That revision is reverted in this branch, and the full file passes.
- Fallback add still doesn't print the "not in the local catalog" warning that `models set` gives for unknown models of a known provider. That could be a follow-up.

## Evidence

I used the published CLI `openclaw@2026.9.8` with isolated `HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH`, starting from an empty config `{}`.

Before (unmodified 2026.9.8):

```text
$ openclaw models set anthropc/claude-sonnet-4-6
Unknown model provider "anthropc". Install a plugin that declares it or configure it under models.providers before selecting "anthropc/claude-sonnet-4-6". Config was not changed.
exit=1
$ openclaw models fallbacks add anthropc/claude-sonnet-4-6
Updated config: ~/openclaw.json
Fallbacks: anthropc/claude-sonnet-4-6
exit=0
$ openclaw models image-fallbacks add opneai/gpt-image-1
Updated config: ~/openclaw.json
Image fallbacks: opneai/gpt-image-1
exit=0
$ openclaw doctor --lint --json   (excerpt)
"anthropc/claude-sonnet-4-6" uses unknown provider "anthropc". No installed plugin manifest or models.providers entry declares it.
```

After (the same 2026.9.8 install with this change applied to the bundled `fallbacks-shared` module, then the same commands):

```text
$ openclaw models fallbacks add anthropc/claude-sonnet-4-6
Unknown model provider "anthropc". Install a plugin that declares it or configure it under models.providers before selecting "anthropc/claude-sonnet-4-6". Config was not changed.
exit=1
$ openclaw models image-fallbacks add opneai/gpt-image-1
Unknown model provider "opneai". Install a plugin that declares it or configure it under models.providers before selecting "opneai/gpt-image-1". Config was not changed.
exit=1
$ openclaw models fallbacks list
Fallbacks (0):
- none
$ openclaw models fallbacks add anthropic/claude-sonnet-4-6        # exit=0
$ openclaw models image-fallbacks add openai/gpt-image-1           # exit=0
$ openclaw models fallbacks add ollama/llama3.2                    # exit=0
```

**Released versions affected.** 2026.9.8 (latest) was reproduced live. In 2026.10.1-beta.1 and 2026.8.35 (extended-stable), the shipped `addFallbackCommand` has no unknown-provider check.

**Tests**

- New: `src/commands/models/fallbacks-shared.test.ts`, "models {fallbacks,image-fallbacks} add > rejects an unknown provider without writing config". It runs the real CLI registration and `addFallbackCommand`, faking only `transformConfigFile` to record whether a write happens.
  - It fails on current `main`: 2 failures, "promise resolved undefined instead of rejecting".
  - It passes with this change.
- On the current head, these pass in one run: `model-selection.runtime.test.ts`, `fallbacks-shared.test.ts`, `aliases.test.ts`, and `set.test.ts` (4 files, 54 tests, `--maxWorkers=1`, 146s wall time, most of it cold transform).
- `pnpm test src/commands/models/fallbacks-shared.test.ts --maxWorkers=1` took about 54s wall time on its own. The new cases take 3.2s and 0.4s. The first does the cold load of the plugin manifest metadata that the provider check reads, which is the contract being tested.
- `src/cli/models-cli.test.ts` passes.
- `pnpm tsgo:core` and the commands test tsconfig typecheck pass.
- `oxfmt --check` and `oxlint` on the changed files are clean.
- I ran the repo's `autoreview` on the branch. It found no actionable findings.
