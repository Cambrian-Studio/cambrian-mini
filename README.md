# baby Cambrian

Cambrian is a collective that ships products with a factory line: a member proposes an idea, a quorum of the collective signs the brief with passkeys (today a founding council of 3, threshold 2), AI agents build it behind walls using NEAR AI Cloud, every run leaves a receipt, and a run that ends RED is drafted into a rule which, once a council member accepts it, the next brief is checked against. This repository is the public, pruned version of that line plus the app to use it. It was written 12–14 November 2026 for NEAR HACKATHON; the line itself was ported from Cambrian's private line (built 3–10 November), which built the product Upread.

## Try it

Needs Node 22 or newer and git. No keys, no account, no dependencies to install.

```sh
git clone https://github.com/Cambrian-Studio/cambrian-line && cd cambrian-line
npm ci
```

**1. `npm test`** — unit tests and attack tests. Expect the last line:

```
247 passed, 0 failed
```

On macOS the last line is `246 passed, 0 failed, 1 skipped (each prints its reason above)`: the skipped test is the bubblewrap wall, which exists on Linux only. On Linux install bubblewrap first (`sudo apt-get install bubblewrap`); without any sandbox the wall tests print their reason and skip, and the line itself refuses to execute anything.

**2. `npm run judge`** — re-derives the claims on your machine, offline. Expect 16 numbered lines, each with a detail after a dash; these eight and the summary, shortened here to their titles:

```
 1. [ok] the committed contract wasm is the one SHA256SUMS names — sha256 3e547da4f94b14de…
 2. [ok] the council file names its members and a threshold of at least two
 3. [ok] receipts rebuild from the run records
 7. [ok] a NEAR AI response signature verifies offline, and a changed byte does not
10. [ok] the line runs a ticket end to end offline
11. [ok] attack: unapproved, 1-of-3 and altered tickets are refused
12. [ok] the threshold is a parameter: a council of 7 with threshold 4 releases at 4, refuses at 3, refuses an altered brief
13. [ok] attack: the push guard refuses main, a forced push and a + refspec; it accepts build/<ticket-id>
judge: 16 checks — 11 ok, 5 skipped, 0 failed
```

`[skip]` means "could not be observed here", with the reason on the line; it is never counted as ok. `[FAIL]` exits non-zero. The five skips today: no live run or brief is recorded yet (approvals, the drafted brief, kept output, per-call signatures) and the contract is not deployed.

**3. `npm run demo`** — one ticket through the real line with a stand-in agent and a throwaway test council. Expect, near the end:

```
state     green-no-preview
pushed    refs/heads/build/facts-page-1 @ <commit>; main untouched
recheck   7 of 7 file checks pass again from the kept output (3 run checks skipped)
receipt   sha256 <64 hex>
```

Add `--approvals 1` (`node line/run-cli.mjs --offline --ticket test/line/fixtures/tickets/facts-page-1.json --approvals 1`) and expect `state     refused — not released by the council: 1 of 3 valid approvals; 2 are required. Nothing ran.`

**4. `npm start`** then open `http://localhost:8787/` — the app. With no key file it says `REPLAY mode` and shows the recorded runs. Open **Receipts**, pick a run, press **Verify this receipt**: the browser recomputes the sha256 over the receipt's canonical JSON and shows `Hash matches.`. (This proves the browser and the server serialise and hash the receipt identically; it becomes tamper evidence once the hash is also recorded somewhere the server cannot change.) Open **The line** and press **Replay** on a run to watch its stations. Every button that would spend or sign explains what it would do instead of doing it.

**5. The contract, executed** (no Rust needed): `node --test test/near/verify-wasm.test.mjs` runs the committed 1.8 kB wasm itself with stub host functions → `ℹ pass 9`, `ℹ fail 0`.

## The loop

1. **Idea → brief.** A member types an idea (`web/screens/talk.js`). On the hosted app only an enrolled council member can, with a passkey signature over the idea. In LIVE mode one NEAR AI call (a second if the first draft is refused) drafts a brief: title, goal, acceptance checks, out of scope, budget in dollars. The brief is written by an open model NEAR AI hosts inside a TEE (`deepseek-ai/DeepSeek-V4.1-Flash-1017`); the call's signature and exact bytes are kept beside the ticket, and the ticket carries the response hash. Code, not the model, decides what stands: the draft is parsed as a ticket, clamped to the budget rules and linted against every lesson (`tickets/brief.mjs`, `lessons/lessons.mjs`).
2. **Approval.** Members propose; a quorum of the collective signs. Each signer signs the ticket's hash with a passkey, and that hash covers the hash of the model response the brief came from. Today the collective's signers are a founding council of 3 with a threshold of 2. The threshold is a parameter of `data/council.json` (N members, M signatures, never below 2): the same code releases a 7-member council at 4 signatures, and the judge runs that case. How a collective of 100 or more decides (quorum by role, weighting, an on-chain council via Trezu) is next, not built. At the threshold the ticket is released (`approvals/release.mjs`); the signatures are stored with the ticket.
3. **Build.** The line (`line/run.mjs`) checks the signatures itself, then runs a coding agent (OpenCode) inside a sandbox. The agent's only door to a model is a bridge (`line/kit/bridge.mjs`) that prices every call and stops at the ticket's budget. Builds run on `anthropic/claude-opus-5-5` through NEAR AI Cloud, at most $2 a build; those calls are signed by NEAR AI's attested gateway, not by the model.
4. **Test.** The ticket's checks run on a fresh clone, inside the sandbox. RED twice: nothing leaves the machine.
5. **Preview.** GREEN: the commit is pushed to `build/<ticket-id>` and the output is deployed to a Vercel preview.
6. **Receipt.** The run record becomes a receipt with a sha256 (`receipts/receipt.mjs`). That hash is what the receipt contract is for; recording it is a manual command today and nothing is on chain yet (see the limits).
7. **Lesson.** On RED (not on a refused or blocked run), Cambrian drafts one rule from the failure; it becomes a rule only when a council member accepts it with a passkey; the next brief is then linted against it (`lessons/draft.mjs`, `lessons/store.mjs`).

## NEAR features used

| Feature | How it is used | Status |
|---|---|---|
| NEAR AI Cloud inference | Every model call goes to `https://cloud-api.near.ai/v1`; cost per call is NEAR AI's `/v1/models` price × the usage the call reports (`near/nearai.mjs`). | built, tested; exercised live in rehearsal builds |
| NEAR AI response signatures and TEE attestation | Two levels, and the receipt says which. **Model-signed:** the brief is written by an open model inside a GPU TEE, and its response is signed inside that TEE. **Gateway-signed:** build calls go to a model NEAR AI routes to an outside provider; NEAR AI's attested gateway signs `sha256(request):sha256(response)` for each call, which shows what was relayed, not where the model ran. Signatures, the hashes they bind and the Intel TDX quote chain are verified offline (`near/nearai.mjs`, findings in `near/ATTESTATION.md`). | built, tested on recorded real responses; exercised in rehearsal builds |
| Receipt contract | Raw Rust, no SDK, 1.8 kB: one method, `record_receipt(32 bytes)`, that emits one event log. No state, no deposit (`contracts/receipts`). A receipt is "on NEAR" when a transaction signed by the recorder account logged its hash; `scripts/verify-receipt.mjs` checks that with read-only RPC calls. | built, tested by executing the wasm; **not deployed** |
| Function-call access keys | The recorder signs with a key limited to `record_receipt` on the receipt contract and refuses a full-access key (`near/record.mjs`). | built, tested against a stub node; never sent a real transaction |
| Staking | The Stake screen shows the stake, its account and transaction, and NEAR AI's published staking-for-inference formula as separate facts (`data/stake.json`). | placeholder until the stake transaction is recorded |
| Named accounts | The contract account and the one recorder account will be named accounts, written to `data/chain.json` at deploy time. The recorder's signature is what gives a logged hash its meaning. | pending the deploy |
| Sputnik DAO approval via Trezu | The 2-of-3 approval as an on-chain DAO vote (`approvals/dao.mjs`). | **not built**: a stub that says so |

## Claims

Every claim, its `file:line`, its test and its status are in [CLAIMS.md](CLAIMS.md), including the ones that are not true yet. `test/docs/claims.test.mjs` fails if a reference there does not exist. The invariants and what enforces each are in [AGENTS.md](AGENTS.md).

## Honest limits

- **Nothing is on chain yet.** The receipt contract is written, tested and built, not deployed. It is log-only: anyone can call it and log any hash, so a record counts only when its transaction was signed by the named recorder account. The wasm has been executed in tests, never on a NEAR node. Receipts show "hash computed, not yet on chain". No mainnet transaction has been signed by this project.
- **On-chain approval is next, not now.** Approval today is 2 of 3 passkey signatures checked by this code. The Sputnik DAO vote is a stub.
- **One stake, and it is not recorded here yet.** `data/stake.json` is a placeholder. When it is filled, it is one member's stake. The stake did not by itself pay for the builds; inference is paid in NEAR AI credits, and the Stake screen shows the stake and the spend as separate facts.
- **What is replay.** The hosted demo and `npm start` without a key show recorded runs. The three Upread runs were built on Cambrian's private line on 9 November and imported here by a converter that is not published, because it has to name the private record's fields to read them. `test/import/committed-runs.test.mjs` checks the result. They were approved there by one council member's passkey; that signature is not in this repository and is not verifiable from it. They used a different model (`anthropic/claude-opus-5-5`, as their records say), captured no signatures, and their dollars are the private line's own rate table times reported usage, not this repository's pricing. Their two GREEN runs say `green-preview` because the private line made previews; those previews sat behind a sign-in, so no address is shown.
- **The collective is three people today.** "The collective signs" means, today, 2 of a founding council of 3. A larger collective deciding by quorum is a parameter away in code and not yet a fact.
- **The council is not enrolled yet.** `data/council.json` names three members and holds no passkey until each enrols. Until a live build is recorded, the 2-of-3 rule is proven with software passkeys in tests, against the real verifier.
- **The walls differ by platform.** macOS: `sandbox-exec`. Linux: bubblewrap with `--unshare-all` (a new, empty network namespace, so no network at all; the bridge is reached through a unix socket), or a `--network none` container. The container fallback has never been executed. With no sandbox, the line only replays.
- **Attestation has an online half we do not check.** Intel TCB status, GPU evidence and image provenance need online verifiers; the judge reports them as skipped.
- **Costs are as reported.** For runs of this line, a call's dollars are NEAR AI's published price times the token usage NEAR AI reports for that call. We do not independently measure usage. A ticket's dollar budget is checked before each call, so the call in flight when it is reached still completes.
- **The eight starting lessons were carried over, not accepted here.** They come from the private line; three of them have no single run behind them. No lesson has yet been drafted from a RED run of this line and accepted by passkey.
- **The judge and the demo are keyless, not network-free.** The stand-in build's install step may reach `registry.npmjs.org` through the line's allow-listed tunnel. They have not been run with the network off.
- **The repository is private until submission.** Until it is public the clone command above fails, and until the pull requests are merged `main` holds only the first commit.
- **The enrolment trusts the browser for the public key.** A passkey's public key is taken from the browser at enrolment, behind a one-time invite; the attestation statement of the authenticator is not checked.

## Repository map

```
app/         the server (REPLAY and LIVE), the record → JSON snapshot, the static demo builder
web/         the UI: Talk, Approvals, The line, Products, Receipts, Lessons, Stake
tickets/     the ticket shape and its validation; idea → brief
approvals/   passkey verification, the 2-of-3 release rule, council enrolment, the DAO stub
line/        the factory line: run, checks, push guard, budget, preview, notifications
line/kit/    the bridge to NEAR AI, the sandbox (macOS profile, bubblewrap, container), the wall probe
lessons/     the rules, the linter, drafting a lesson from a RED run
receipts/    canonical JSON and the receipt
near/        NEAR AI client and attestation, RPC reads, the receipt recorder
contracts/   the receipt contract (Rust), the built wasm, its checksum
data/        the committed record: council, runs, products, stake
scripts/     judge, test runner, invite, deploy helpers
test/        unit tests and attack tests
```

## Disclosure

Runtime dependencies: none (Node.js builtins only). Tools it runs: git; OpenCode (`opencode-ai`, the coding agent, installed for LIVE mode only); bubblewrap, docker/podman or macOS `sandbox-exec` (the wall); a pinned Rust toolchain to rebuild the contract (no crates); gitleaks (optional secret scan); the fonts Archivo and Chivo Mono. Services in LIVE mode: NEAR AI Cloud, Vercel, GitHub, and Telegram only if configured. All code here was written by AI coding agents (Claude, through Claude Code) directed by the team, and the line is a port of Cambrian's private line (3–10 November, inside the hackathon window). Full detail in [HACKATHON.md](HACKATHON.md). The demo storyboard is [DEMO.md](DEMO.md). Licence: MIT.
