## What Problem This Solves

Fixes: `openclaw models fallbacks add`, `openclaw models image-fallbacks add`, and `openclaw models aliases add` save a model whose provider doesn't exist, such as the typo `anthropc/...`. `openclaw models set` already refuses the same input: it exits 1 and leaves config unchanged. These three commands skip that check, so the typo is written to `agents.defaults.model.fallbacks` or `agents.defaults.models` with exit 0. The mistake stays hidden until failover needs that fallback, someone selects the alias, or `openclaw doctor` reports it as an unknown provider.

## User Impact

User impact: someone adding a backup model or an alias such as `fast` can no longer mistype the provider and get "Updated config" for an entry that can never resolve. All three commands now reject an unknown provider with the same message `models set` uses, and config is left untouched. Known providers keep working, including providers without a local catalog (for example `ollama/...`) and models missing from a known provider's catalog.

## Why This Change Was Made

These commands now validate input the same way `models set` already does, as described in `docs/cli/models.md`. The check lives in one helper, `requireKnownModelProvider` in `src/commands/models/shared.ts`, extracted unchanged from `updateDefaultModelPrimaryConfig`. `addFallbackCommand`, which covers both `fallbacks` and `image-fallbacks`, and `modelsAliasesAddCommand` now call it too. The error text is the same. The check runs inside the existing config transform before any write, matching `models set`. The docs line that lists which commands refuse unknown providers now includes these three commands.

Left as a follow-up to keep this narrow: fallback and alias add still don't print the "not in the local catalog" warning that `models set` gives for unknown models of a known provider.

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
$ openclaw models aliases add fast anthropc/claude-sonnet-4-6
Updated config: ~/openclaw.json
Alias fast -> anthropc/claude-sonnet-4-6
exit=0
$ openclaw doctor --lint --json   (excerpt)
"anthropc/claude-sonnet-4-6" uses unknown provider "anthropc". No installed plugin manifest or models.providers entry declares it.
```

After (the same 2026.9.8 install with this change applied to the bundled modules, then the same commands):

```text
$ openclaw models fallbacks add anthropc/claude-sonnet-4-6
Unknown model provider "anthropc". Install a plugin that declares it or configure it under models.providers before selecting "anthropc/claude-sonnet-4-6". Config was not changed.
exit=1
$ openclaw models image-fallbacks add opneai/gpt-image-1
Unknown model provider "opneai". Install a plugin that declares it or configure it under models.providers before selecting "opneai/gpt-image-1". Config was not changed.
exit=1
$ openclaw models aliases add fast anthropc/claude-sonnet-4-6
Unknown model provider "anthropc". ... Config was not changed.
exit=1
$ openclaw models fallbacks list
Fallbacks (0):
- none
$ openclaw models fallbacks add anthropic/claude-sonnet-4-6        # exit=0
$ openclaw models image-fallbacks add openai/gpt-image-1           # exit=0
$ openclaw models fallbacks add ollama/llama3.2                    # exit=0
$ openclaw models aliases add local ollama/llama3.2                # exit=0
```

**Released versions affected.** 2026.9.8 (latest) was reproduced live. In 2026.10.1-beta.1 and 2026.8.35 (extended-stable), the shipped `addFallbackCommand` and `modelsAliasesAddCommand` have no unknown-provider check.

**Tests**

- New: `src/commands/models/fallbacks-shared.test.ts`, "models {fallbacks,image-fallbacks} add > rejects an unknown provider without writing config". It runs the real CLI registration and `addFallbackCommand`, faking only `transformConfigFile` to record whether a write happens.
  - It fails on current `main`: 2 failures, "promise resolved undefined instead of rejecting".
  - It passes with this change: 12/12.
- New: `src/commands/models/aliases.test.ts`, "modelsAliasesAddCommand > rejects an unknown provider without writing config".
  - It fails on current `main`: 1 failed, 15 passed.
  - It passes with this change: 16/16.
- Wall times with `pnpm test <file> --maxWorkers=1`, about 81–88% of each spent in transform:
  - `fallbacks-shared.test.ts`: about 54s. The new cases take 3.2s and 0.4s. The first does the cold load of the plugin manifest metadata that the provider check reads, which is the contract being tested.
  - `aliases.test.ts`: about 54s. The new case takes 0.33s.
- These neighboring files pass: `src/commands/models/set.test.ts`, `src/cli/models-cli.test.ts`, and `src/commands/models/model-selection.runtime.test.ts` (107 tests).
- `pnpm tsgo:core` and the commands test tsconfig typecheck pass.
- `oxfmt --check` and `oxlint` on the changed files are clean.
- I ran the repo's `autoreview` on each commit. It found no actionable findings.
- Not run locally: `src/commands/models.set.e2e.test.ts`, whose E2E preparation can't run in my environment. Its fallback add cases use known providers (`z-ai`, `anthropic`, `moonshot`), so this check shouldn't affect them; CI covers it.
