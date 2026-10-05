## What Problem This Solves

Fixes: assistant replies that mention the `<|` and `|>` operators in plain text silently lose everything between them before delivery, even across paragraphs.

Every reply goes through `sanitizeAssistantVisibleText`, which calls `stripModelSpecialTokens` to remove leaked control tokens such as `<|assistant|>` (#40020). Its pattern, `/<[|｜][^|｜]*[|｜]>/g`, lets the token body contain anything except a pipe, including spaces and newlines. Any `<|` followed later by `|>` therefore counts as one "token", and the text between them is deleted. F# and Elm use these as pipe operators, so a reply such as:

```text
Elm: use <| for application.

Later: chain with |> instead.
```

reaches the user as `Elm: use  instead.`, with no sign that anything was removed. Inline code spans are protected, but plain prose, which is how models often mention operators, is not.

## User Impact

User impact: on every channel that uses the shared visible-text sanitizer (IRC, Telegram, WhatsApp, Google Chat, iMessage, and others), replies that mention `<|` and later `|>` outside backticks are now delivered intact. Leaked control tokens are still stripped.

## Why This Change Was Made

Real leaked control tokens never contain whitespace. Examples are `<|im_start|>`, `<|eot_id|>`, `<|start_header_id|>`, `<|channel|>`, and DeepSeek's `<｜begin▁of▁sentence｜>`, which uses U+2581 rather than a space. The fix adds `\s` to the excluded body characters (`[^|｜\s]*`), so prose spans no longer match. Every existing token case still strips, including the adjacent-token, punctuation, CJK, astral, and combining-mark cases in the existing tests.

Tradeoff: a hypothetical control token that contains a literal space would no longer be stripped. I don't know of any tokenizer that uses one.

## Evidence

**Live check through a real channel send on the published `openclaw@2026.9.8`.** Setup:

- isolated `HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH`, running `openclaw gateway run`
- `@openclaw/irc` connected to a local miniircd
- a local fake OpenAI-compatible provider whose reply is `"Elm: use <| for application.\n\nLater: chain with |> instead."`

An IRC user sent the bot a DM.

Before (published, unmodified), the user received:

```text
Elm: use  instead.
```

After applying the same one-line regex change to the installed bundle, restarting, and sending the identical DM, the user received:

```text
Elm: use <| for application.  Later: chain with |> instead.
```

IRC always flattens the paragraph break onto one line.

**Released versions affected.** 2026.9.8 (latest), 2026.10.1-beta.1, and 2026.8.35 (extended-stable) all ship `/<[|｜][^|｜]*[|｜]>/g`.

**Tests**

- New: `keeps prose between pipe operators` in `src/agents/embedded-agent-utils.strip-model-special-tokens.test.ts`. It fails on current `main` and passes with this change. The whole file passes: 19 tests.
- `pnpm test src/agents/embedded-agent-utils.strip-model-special-tokens.test.ts --maxWorkers=1` took 5.2s wall time. The new test is pure string work and takes milliseconds.
- The sibling and caller suites pass: `src/shared/text` (11 files, 260 tests) and `src/infra/outbound/sanitize-text.test.ts` (43 tests).
- `oxfmt --check` and `oxlint` on the changed files are clean.
- I ran the repo's `autoreview` on the branch. It found no actionable findings. It confirmed that common control tokens still match, and its only note is the space-in-token tradeoff above.
