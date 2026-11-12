# NEAR AI Cloud: what is signed, what we verify

Probed live on 2026-11-12 against `https://cloud-api.near.ai/v1`. Every statement below was observed on
the API that day or is quoted from the docs with its URL. The recorded responses are in
`test/near/fixtures/`; the code is `near/nearai.mjs`; the proof is `node --test test/near/`.

## Finding

Yes. NEAR AI Cloud signs every chat completion, and the signing key is bound to an Intel TDX quote.
Who signs depends on the call:

| Call | `signature_kind` | Signed text | Signer |
| - | - | - | - |
| Non-streaming, model hosted by NEAR AI in a TEE | `provider_tee` | `<model>:<sha256 request>:<sha256 response>` | key inside the model's TEE |
| Streaming, same models | `gateway` | `<sha256 request>:<sha256 response>` | key inside the gateway's TEE |
| Model proxied to an outside provider (anthropic/*, openai/*, google/*, ...) | `gateway` | `<sha256 request>:<sha256 response>` | key inside the gateway's TEE |

Only `provider_tee` ties a response to a model running in a TEE. A `gateway` signature says the gateway's
TEE relayed exactly these bytes; it says nothing about where the model ran.

The hashes are over the exact request body sent and the exact (decompressed) response body received.
`chat()` computes both; in all recorded calls they equal the hashes inside the signed text.

## Endpoints and literal statuses

| Request | Status | Result |
| - | - | - |
| `GET /v1/attestation/report?model=deepseek-ai/DeepSeek-V4.1-Flash-1017&provider=near&signing_algo=ed25519&nonce=<64 hex>` | 200 | gateway report + 1 model report (about 300 kB) |
| same, `signing_algo=ecdsa` | 200 | same reports, Ethereum-style signing addresses |
| same, no `Authorization` header | 200 | the report is public |
| `GET /v1/attestation/report?model=anthropic/claude-haiku-5-5` | 503 | "TEE attestation is not supported for external providers" |
| `GET /v1/signature/<chat_id>?signing_algo=ed25519` (non-streaming, TEE model) | 200 | `provider_tee` |
| `GET /v1/signature/<chat_id>?signing_algo=ecdsa` (same chat) | 200 | `provider_tee`, 65-byte secp256k1 signature |
| `GET /v1/signature/<chat_id>` for a streamed completion | 200 | `gateway` |
| `GET /v1/signature/<chat_id>` for `anthropic/claude-haiku-5-5` | 200 | `gateway` |
| `GET /v1/signature/<unknown id>` | 404 | "Signature not found" |
| `GET /v1/signature/<chat_id>` without a key | 401 | "Missing authorization header" |

Defaults differ (`/signature`: ecdsa; gateway report: ed25519), so the client always names the algorithm.
It uses ed25519 by default because node:crypto verifies it natively; ecdsa is verified with the
pure-JS keccak-256 and secp256k1 recovery in `near/nearai.mjs`.

## Which models are attestable

`GET /v1/models` lists 63 models. `owned_by` tells them apart:

- `nearai` (12): hosted by NEAR AI in a TEE; model report with TDX quote and NVIDIA GPU evidence;
  `provider_tee` signatures. Chat models with tool support: `deepseek-ai/DeepSeek-V4.1-Flash-1017`,
  `z-ai/glm-5.3-flash`, `Qwen/Qwen3.8-27B`, `Qwen/Qwen3.6-35B-A3B-FP8`.
- `attested 3p` (4: `z-ai/glm-5.3`, `moonshotai/kimi-k3`, `moonshotai/kimi-k2.6`, `deepseek/deepseek-v3.2`):
  the report carries another provider's evidence (for `z-ai/glm-5.3`: provider `tinfoil`, an AMD SEV-SNP
  report), not a NEAR TDX report. Not verified by this code.
- everything else (anthropic, openai, google, x-ai, ...): proxied. No model report (503). Responses are
  served with header `x-serving-provider: non-attested` and carry a `gateway` signature only.

## How the key is bound to the hardware

Each report holds an Intel TDX quote (version 4). Its 64 bytes of report data are
`signing identity, zero-padded to 32 bytes` + `the 32-byte nonce the caller chose`.
The identity is the 32-byte ed25519 public key, or the 20-byte Ethereum address for ecdsa.
The quote also measures the deployed configuration: `MRCONFIGID = 01 || sha256(app_compose) || 15 zero bytes`,
and RTMR3 is the SHA-384 replay of the report's event log. The model report additionally carries
`nvidia_payload`, GPU evidence bound to the same nonce.
Source: https://docs.near.ai/cloud/verification/reference/quote-nonce-signer.md and
https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md (read 2026-11-12).

## What `verifyAttestation` checks offline (node:crypto only, no dependencies)

| Check | What it proves |
| - | - |
| `signature` | the signature over the text is by the stated signing address (ed25519 verify, or secp256k1 recovery of an EIP-191 message) |
| `text_binds_hashes` | the signed text is exactly the model id (for `provider_tee`) and our request and response hashes |
| `report_names_signer` | the TEE report names the same signing address and algorithm, and for `provider_tee` the same model |
| `quote_parses` | the report holds a TDX quote, and the TEE is not in debug mode |
| `quote_binds_signer` | the quote's report data is that signing address followed by the report's nonce |
| `quote_signature_chain` | Intel SGX Root CA (pinned public key) -> platform CA -> PCK certificate -> quoting-enclave report -> attestation key -> the TD report; certificates valid when the report was fetched |
| `config_measured` | the quote measures the reported configuration (`app_compose`) |
| `event_log_replays` | the event log replays to the quote's RTMR3 |

Listed as `skipped`, with the reason, never as passed:

| Skipped | Needs |
| - | - |
| `tcb_status` | Intel's online collateral: is the platform's firmware level current, is anything revoked |
| `gpu_evidence` | NVIDIA's online verifier (NRAS, `https://nras.attestation.nvidia.com/v3/attest/gpu`) |
| `image_provenance` | an online lookup that the measured configuration is a build NEAR AI published |
| `report_freshness` | cannot be proven from a record: the nonce is chosen by whoever fetched the report |

Limits, stated by NEAR AI's own docs and true here: all instances of a model share one signing key, so a
matching signer does not prove which instance answered; and a report plus one signature is not a full
model-to-gateway-to-client chain.

## Claim rows

| Claim | Status | Evidence |
| - | - | - |
| Brief and lesson-draft calls (non-streaming, TEE-hosted model) carry a model-TEE signature over our exact request and response bytes | proven | `tool.*` fixtures; tests "a real completion by a TEE-hosted model verifies offline", "one changed character ... fails" |
| The signing key is inside Intel TDX hardware (quote chain to Intel's root, key in report data) | proven offline | `quote_binds_signer`, `quote_signature_chain`; test "a tampered hardware quote ... fails" |
| Builder calls made by a streaming agent are signed | proven, as `gateway` only | `stream.*` fixtures. A model-TEE signature for builder calls needs the bridge to call upstream without streaming and keep the raw bytes |
| Calls to proxied frontier models are attested by a model TEE | not available | 503 on the report; `gateway` signature only (`proxied.*` fixtures) |
| Platform firmware is current; GPU evidence is genuine; the measured image is NEAR AI's published build | pending | not checked offline: Intel collateral, NVIDIA NRAS and image provenance need online verifiers |

## Recommended builder model

`deepseek-ai/DeepSeek-V4.1-Flash-1017` for the OpenCode agent.

- Attestable: `owned_by: nearai`; a non-streaming call returned a `provider_tee` signature that verifies
  against its TDX report (the `tool.*` fixtures are this call).
- Tool calls work through this API: one real request with a `write_file` tool returned
  `finish_reason: "tool_calls"` and `write_file({"path": "hello.txt", "content": "hi"})`
  (chat id `chatcmpl-b81d43d3-3e81-4843-9823-241b81baaf89`, 312 prompt / 56 completion tokens).
- Fits the $5/day cap: $0.30 per million input tokens, $1.20 per million output, $0.006 per million cached
  input (`/v1/models`, 2026-11-12); 1,048,576-token context. The prompt cache is real: two repeats of the
  same request reported `cached_tokens` 192 and then 256 of 312. $5 buys about 16 million fresh input tokens, or 4 million output.
- Cheaper fallback: `z-ai/glm-5.3-flash` ($0.08 / $0.50 per million, 1M context) and `Qwen/Qwen3.8-27B`
  ($0.04 / $1.35, 262k context). Both returned the same tool call and `provider_tee` signatures in the same probe.

Not measured: coding quality or reliability over a long agent run. Only one tool call per model was made.
Both fallbacks reason by default and spend completion tokens on it (26 and 27 reasoning tokens for the
one-line tool call; DeepSeek spent 0).

## Staking and credits: the published rate

NEAR AI publishes a formula, not a fixed rate.

- "One credit is worth one US dollar of usage on NEAR AI Cloud." Staking rewards, not the staked NEAR, pay
  for inference; credits accrue per second.
  Source: https://docs.near.ai/cloud/staking-for-inference/overview.md (read 2026-11-12).
- `monthly AI usage covered = staked NEAR x NEAR price x APY / 12`; per second:
  `staked NEAR x price x APY / 31,557,600`. The calculator's default reward rate is 4.78% APY
  ("currently ~4.8% network-wide"), and the page says its figures "are illustrative defaults ... not live quotes".
  Source: https://docs.near.ai/cloud/staking-for-inference/calculator (page dated 2026-09-09, read 2026-11-12).
- Example from that formula: 1,000 NEAR at 4.78% covers `1000 x price x 0.0478 / 12` = 3.98 x (NEAR price in USD)
  dollars of inference a month.
- The exact on-chain conversion (`credit_nano_usd_per_reward_unit`) is served by
  `GET /v1/staking/farm/config`, which needs a signed-in session: it answered 401 to no key and 401 to
  an API key. There is no published fixed number of credits per staked NEAR.

Model prices themselves are published per token at `GET /v1/models` and are what `fetchPricing` reads.

## Spend

Nine real calls were made for this research (eight probes and one end-to-end run of the client):
$0.000447 in total, computed from each call's reported usage and the `/v1/models` prices.
