# compaction-guard

Automatic fallback when conversation compaction fails on a Zen-backed model.

## The problem

Sessions on `muse-spark-1.3-contributor` (via the custom `opencode` provider,
`https://opencode.ai/inference/go/openai/v1`) fail automatic compaction: the Zen
gateway rejects the summary call with `400 ... only auto is supported for
tool_choice`. The session then needs a manual model switch for every compaction.

## What this does

- Watches `session.compaction_start` / `session.compaction_complete` events.
- When a compaction **fails** on one of our Zen models, switches the session to
  `deepseek-v4.1-flash` (same provider, 1M context) so the automatic retry
  succeeds.
- When a compaction **succeeds** while the swap is active, restores the
  original model (and reasoning effort).
- Only ever manages models on this machine's custom provider id; built-in
  GitHub models are left alone. Never stacks swaps, never loops.
- `onErrorOccurred` (model-call errors mentioning compaction) is a backup
  trigger in case a failure ever arrives without a completion event.

## Tool

- `compaction_guard_status` — reports armed/swapped state. Useful to verify the
  extension loaded in a session.

## Config

| Variable | Default | Meaning |
|---|---|---|
| `COMPACTION_GUARD_PROVIDER_ID` | `c54b9653-0828-4c58-9a6f-bc67320cfea8` | Custom provider whose models the guard manages |
| `COMPACTION_GUARD_FALLBACK_MODEL` | `deepseek-v4.1-flash` | Short model name to swap to on compaction failure |

If the custom provider is ever recreated (new id), set
`COMPACTION_GUARD_PROVIDER_ID` instead of editing code.

## Test

- `npm test` runs 8 self-contained unit tests against a mocked SDK
  (switch-on-failure, no-double-switch, restore-on-success,
  ignore-foreign-model, stand-down-on-foreign-success, short-form fallback,
  error-hook switch/ignore).
- Live-verified in throwaway chats: the extension loads (via
  `compaction_guard_status`), and `setModel` switches spark→DeepSeek and
  DeepSeek→spark with `sessions.model` confirming each direction.
