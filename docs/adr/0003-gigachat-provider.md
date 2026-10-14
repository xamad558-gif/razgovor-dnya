# ADR 0003: GigaChat as the conversation provider (Anthropic kept behind a switch)

**Status:** Accepted (Oct 2026). Superseded as the default by [ADR 0004](0004-openrouter-provider.md) on 14 Oct 2026:
GigaChat Freemium is no longer offered to new clients (since 1 Sep 2026). The code path is kept behind
`AI_PROVIDER=gigachat`.

## Context
The owner (a student in Moscow) cannot fund the Anthropic API: the account has no credit, a Claude Pro
subscription does not include API usage, and Russia is not an Anthropic-supported region. He chose **GigaChat
(Sber) Freemium for individuals**: 365M tokens for 12 months, split per model (250M Lite `GigaChat-2`, 40M
`GigaChat-2-Pro`, 25M `GigaChat-2-Max`, 50M `GigaChat-3-Ultra`), with one concurrent request stream.

## Decision
- The handler takes a `deps.provider` object (`{ name, repairInvalidJson, modelFor(task), complete(req, ctx) }`) in
  place of `deps.callModel` + `deps.model`. `complete` returns a normalised result
  (`{ model, stop: 'end'|'refusal'|'max_tokens', text, inputTokens, outputTokens }`) or throws a typed
  `ProviderError`. The handler stops knowing the Anthropic response shape; each provider maps its own stop reasons,
  usage and errors in one tested place (`_shared/providers.js`). (D1)
- `Deno.createHttpClient({ caCerts: RUSSIAN_TRUSTED_CA_PEMS })` is created once at module scope and used **only** by
  the GigaChat fetch wrapper. Every other fetch (Supabase, Anthropic) keeps the default (Mozilla) trust store. The
  three certificates (root + two Sub CAs) are committed as a JS module with SHA-256 fingerprints pinned by a unit
  test. TLS verification is never disabled. If `createHttpClient` throws at boot, the GigaChat client falls back to
  plain `fetch`, which still verifies against the default store and fails closed with `UnknownIssuer`. (D4, D5)
- JSON strategy: prompt-only JSON (unchanged "Reply ONLY with JSON" rules) plus `parseModelJson` and the existing
  validators, plus **at most one repair call** when parsing or validation fails and the provider opts in
  (`repairInvalidJson: true`, GigaChat only). `GIGACHAT_STRUCTURED=on` opts into `response_format` (Beta,
  undocumented schema subset) without removing the validators (defence in depth). Anthropic keeps
  `repairInvalidJson: false`, since its schema-constrained output makes repair pointless — that path is unchanged. (D14)
- Models per task (defaults): `chat` → `GigaChat-2-Max`, `evaluate` → `GigaChat-2-Max`, `topic` → `GigaChat-2-Pro`.
  Overridable per-task or globally with `GIGACHAT_MODEL[_CHAT|_EVALUATE|_TOPIC]`, so the owner can switch models (for
  example to the `GigaChat-3-Ultra` challenger) with a secret change, no redeploy. `AI_MODEL` stays Anthropic-only. (D15)
- `AI_PROVIDER` = `gigachat` (default when unset) | `anthropic`. One secret switches providers immediately, with no
  redeploy, as long as the corresponding key secret is set. (D17)

## Quota math
Rough GigaChat token counts, input + output both billed: chat request ≈ 2.5k (system ≈ 0.8k + history + ≈ 0.6k
output); evaluate ≈ 3.5k; topic ≈ 1k.

| Usage | Tokens/day | Tokens/12 mo | Bucket | Headroom |
|---|---|---|---|---|
| Typical day: 10 chat + 1 evaluate on Max | ≈ 28.5k | ≈ 10.4M | Max 25M | ≈ 2.4× |
| Heavy day: 2 conversations | ≈ 57k | ≈ 20.8M | Max 25M | ≈ 1.2× |
| Worst case `AI_DAILY_LIMIT=60`, all chat | ≈ 150k | the bucket lasts ≈ 165 days | Max 25M | n/a |
| Same typical usage on Ultra (challenger) | ≈ 28.5k | ≈ 10.4M | Ultra 50M | ≈ 4.8× |
| Topic on Pro, ~2/week | tiny | ≈ 0.1M | Pro 40M | huge |

If the Max bucket runs out, 402 maps to `billing`. The fix is a secret change (`GIGACHAT_MODEL_CHAT=GigaChat-3-Ultra`
or `GigaChat-2-Pro`), with no deploy. `AI_DAILY_LIMIT` is recommended at **30** for this single-learner freemium
setup (the owner's choice, documented in the runbook).

## Consequences
- Learner text now goes to Sber (a Russian provider, Russian law). Acceptable for the owner as the sole learner.
  Before inviting other learners, re-check GigaChat's personal-tariff terms for multi-user / commercial use and data
  use, and move to a paid or legal-entity plan if needed.
- One concurrent stream, so a second simultaneous request gets a 429 ("busy").
- GigaChat may refuse politics or religion topics (`blacklist` finish_reason → `refused`). R1 includes those topics,
  so watch the `refused` rate after deployment.
- Sub CA 2022 expires 2027-03-06. The root is valid to 2032-02-27. Calendar a review before the Sub CA expiry.

## Contingency
If GigaChat blocks non-Russian source IPs (Supabase runs in Frankfurt) or port 9443 is unreachable, the next step is
a small relay in Russia (a Yandex Cloud Function, Node 22, with the CA in `tls.ca`), called by the Edge Function over
public-CA TLS with a shared secret. Not built now; this is written down so it is not reinvented under pressure.

## Alternatives rejected
- **Stay on Anthropic:** unfundable from Russia today.
- **OpenAI-compatible resellers / proxies to Claude:** ToS and key-exposure risk.
- **YandexGPT:** needs Yandex Cloud billing; no comparable free tier for this owner.
- **GigaChat npm SDK:** an extra dependency for ~150 lines of plain `fetch`; rejected per S8 (no new dependencies).
- **Disabling TLS verification:** rejected, P0 — the scoped CA trust (D4) solves the same problem without it.

## Live verification addendum
(Filled in by the main session + owner after deployment, with the owner's real key: latency, JSON quality,
`ok`/`ok_repaired`/`invalid_output`/`refused` rates, and the chosen model/structured-output settings.)
