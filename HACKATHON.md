# Disclosure for NEAR HACKATHON

## When this was written

- **This repository** was written 12–14 November 2026. Its git history starts on 12 November; each feature arrived as its own pull request.
- **The line was ported, not invented here.** `line/`, `tickets/ticket.mjs` and `lessons/` are ports of Cambrian's private build line, which was written from 3 November 2026 (its build-line code from 5 November) and built the product Upread on 9 November. The hackathon window runs from the announcement on 19 October 2026 (rule Q-001), so that earlier work is also inside the window. It is disclosed here because it was not written in this repository.
- **Written new in this repository:** the 2-of-3 passkey approvals (`approvals/`), receipts and canonical hashing (`receipts/`), the NEAR AI client and attestation verification (`near/nearai.mjs`), the receipt contract and its tooling (`contracts/`, `near/rpc.mjs`, `near/record.mjs`, `scripts/verify-receipt.mjs`), the Linux sandbox modes and the direct bridge to NEAR AI (`line/kit/`), the Vercel preview step (`line/vercel.mjs`), the app and its UI (`app/`, `web/`), the judge (`scripts/judge.mjs`), and all tests.
- **Reused look:** the UI follows the visual language of Cambrian's members page (black ground, Archivo and Chivo Mono, one green dot) and uses three drawn figures of the council members from it.
- **Imported evidence:** `data/runs/upread-*` are three run records from the private line (one RED, two GREEN), converted by a script that stays private because it names the private record's fields. The converter is written not to alter numbers and has its own test for that, kept with it; from this repository that cannot be re-checked. `test/import/committed-runs.test.mjs` checks the committed result for private shapes and for the figures the lessons quote. They are labelled "earlier run on Cambrian's private line" wherever they appear.

Cambrian the collective and its private system exist outside this repository and predate the hackathon. Nothing of them is submitted here except what is listed above.

## Libraries and tools

Runtime dependencies of the app: **none**. It uses Node.js builtins only (`package.json` has no `dependencies`).

| What | Where it is used | Licence |
|---|---|---|
| Node.js 22+ | everything | MIT |
| git | the line's worktrees, commits and pushes | GPL-2.0 |
| OpenCode (`opencode-ai`, installed by `npm run setup:live` into `.line/tools`, not committed) | the coding agent the line runs in LIVE mode | MIT |
| Rust 1.99.1 with the `wasm32-unknown-unknown` target (rustup), no third-party crates | rebuilding `contracts/receipts.wasm` (`contracts/build.sh`); not needed to run or test anything | MIT / Apache-2.0 |
| bubblewrap, or docker/podman (Linux); `sandbox-exec` (macOS) | the wall around the agent | LGPL-2.0 / Apache-2.0 / part of macOS |
| gitleaks (optional) | the pre-commit secret scan | MIT |
| Archivo, Chivo Mono | the UI's fonts, self-hosted in `web/assets/fonts` with their notices | SIL OFL 1.1 |
| GitHub Actions `actions/checkout`, `actions/setup-node` | CI | MIT |

Services called in LIVE mode: NEAR AI Cloud (inference, pricing, signatures, attestation reports), Vercel (previews), GitHub (build branches), and the Telegram Bot API only when a bot token file and chat id are configured (off by default). REPLAY mode calls none. The judge, the demo and the tests use no key; their stand-in builds may reach `registry.npmjs.org` through the line's tunnel, and one wall test tries a few public hosts to prove they are refused.

Test vectors: the borsh and signature vectors in `test/near/record.test.mjs` are from near-api-js (`@near-js/transactions@1.3.0`). The attestation fixtures in `test/near/fixtures` are public responses recorded from NEAR AI Cloud on 12 November 2026.

## AI-written code

All code, tests and documents in this repository were written by AI coding agents (Claude, through Claude Code) directed and reviewed by the team; commits carry a `Co-Authored-By` line saying so. The private line it was ported from was written the same way. The products the line builds are written by a different model, served by NEAR AI Cloud (`deepseek-ai/DeepSeek-V4.1-Flash-1017` in the rehearsal builds), running in OpenCode.

## Tracks

The team lead chooses the tracks at submission. The ones this project was built toward:

- `security` — sandboxed agents, spend caps, function-call access keys, and TEE-signed model calls: the capture and the offline verification are built and tested on recorded NEAR AI responses; no recorded build of this line carries one yet, and TEE image provenance is not checked.
- `privacy` — inference on NEAR AI Cloud with per-response signatures verified offline (same status as above).
- `business` — a product line where humans set the constraints (approval, budget) and agents do the building.
- `social` — a council approving shared work; the Sputnik DAO / Trezu vote is the next step and is **not built** (see CLAIMS.md).

## Other submissions

None by this team at the time of writing.
