# Cambrian Mini: Machines build. The collective decides.

Cambrian Mini is a system in which a small group of people, a council, approves a written description of a product, a brief, by signing it with passkeys (the fingerprint or face sign-in built into phones and laptops). When enough of them have signed, an AI coding agent builds the product in a sandbox with a fixed budget. Every build leaves a record of each model call, what it cost and which checks passed, and the hash of that record can be logged on NEAR mainnet, where anyone can check it.

It is for a collective that wants AI-built products with a record anyone can verify: who approved what, and what each build cost. It is the open part of Cambrian, a product studio owned by its members, written for NEAR HACKATHON.

Two products are live, each built here on 14 November from a brief that two council members signed:

- **Upread Mini** reads a text to you one word at a time. [Open it](https://cambrian-upread-mini-crnw8wneo-cambrian-collective.vercel.app) · [its record](https://cambrian-line-replay.vercel.app/#/receipts/upread-mini-086cdf) · [the record's hash on NEAR](https://nearblocks.io/txns/CmFEiKKFuREVvmosTFMqiarbrekGyCSFHz2NnduWqBmv)
- **Postmark** makes London postcards that unlock only within 150 m of the landmark. [Open it](https://cambrian-postmark-m2x6yxrfp-cambrian-collective.vercel.app) · [its record](https://cambrian-line-replay.vercel.app/#/receipts/postmark-6ee0a5) · [the record's hash on NEAR](https://nearblocks.io/txns/4wYmP1KUzFGkz8dhWQAgnW1Q7Y3dsswhJDRofLf1F5Hz)

We staked our own capital first: 3,045 NEAR, about €10,000 when staked on 13 Nov, with NEAR AI. [The stake transaction](https://nearblocks.io/txns/9US5CcTaSYiX2DS7pGLWoS4sYpBZ4s9BvSEq1CgoJ6eo); `npm run judge` check 17 reads the position from mainnet.

## Three ways in

1. **The hosted replay, instant.** Open <https://cambrian-line-replay.vercel.app/#/verify>, pick a build and press **Verify this receipt**. Your own browser recomputes the sha256 of that build's record and reports that it matches.
2. **`npm run judge`, seconds.** Clone, `npm ci`, `npm run judge`: 17 numbered checks on your machine with no keys, ending `judge: 17 checks — 16 ok, 1 skipped, 0 failed`. Measured from a fresh clone on 14 November: about 5 s on macOS, 3 s in a plain Linux container (`node:22-bookworm`). Each skip prints its reason. Checks 16 and 17 read NEAR mainnet from a public archival node.
3. **Your own build, about a minute.** `npm run solo` with your own NEAR AI key: you talk an idea through, sign the brief with your own passkey as a council of one, and watch it build. Measured on 13 November from `git clone` to the first preview: 57 s and $0.015. The next section has the steps. Without a key, `npm run demo` sends one brief through the same build path with a stand-in agent and a throwaway test council, and you see `state     green-no-preview` (on Linux only where bubblewrap can build its sandbox; in a default Docker container you see `state     blocked`, see [Try it](#try-it)).

In a plain Linux container without user namespaces, `npm test` ends `276 passed, 0 failed, 11 skipped (each prints its reason above)` and the judge ends `15 ok, 2 skipped, 0 failed`: every check that needs no sandbox passes, including the ones that re-verify the council's signatures and read mainnet. The 11 tests and the judge's check 10 skip there because they would run agent or product code, which this code refuses to do without a sandbox it can build (check 5 skips on every machine, for the reason given under [Try it](#try-it), which also has the command for the full run).

Every model call is real, priced and signed; nothing in the record is simulated. One exception is labelled wherever it appears: the three earlier builds of Upread were imported from Cambrian's private setup, and their calls are real and priced but carry no signatures.

## Run your own line

One person, one machine, one real build. It needs Node 22 or newer, git, and your own NEAR AI key (from cloud.near.ai) saved in a file only you can read. On Linux it also needs bubblewrap with user namespaces (see the note under [Try it](#try-it)); macOS has its sandbox built in.

```sh
git clone https://github.com/Cambrian-Studio/cambrian-mini && cd cambrian-mini
npm install
chmod 600 /path/to/your-nearai.key
NEARAI_KEY_FILE=/path/to/your-nearai.key npm run solo
```

The first start installs the coding agent (OpenCode) once, then prints four links on `http://localhost:8787` (set `CAMBRIAN_PORT` for another port):

1. **Enrol your passkey.** Open the one-time link and press "Create a passkey". You are now a council of one, and the app says so wherever it shows the council ("1 of 1 · solo, a council of one").
2. **Talk.** Type any small idea. Cambrian discusses it with you and proposes what to cut. Say "ready" or press "Draft the brief", change it with further instructions if you like, then press "Send to council".
3. **Sign.** Open the brief in Approvals and press "Sign with passkey". One signature releases it, because this council has one member.
4. **Watch it build.** The steps light up on Watch a build. When the build passes, Products links the page it built, served from your own machine at `/preview/<build id>/`, and Verify recomputes the hash of its record in your browser.

What it costs: one build may cost at most $2, a day at most $5 and the app in total at most $15; both are enforced before each model call. The run we timed on 13 November, from `git clone` to the first preview, took 57 seconds and cost $0.015: $0.006 for the conversation and the brief, $0.009 for the build. It built a Celsius and Fahrenheit converter on `Qwen/Qwen3.6-35B-A3B-FP8`, an open model NEAR AI hosts in a TEE, which is the solo default (set `LINE_MODEL` for another model; a larger model costs more). That run used a software passkey in a scripted browser, not a phone or a security key.

What it does not do: nothing is recorded on NEAR, because a solo line has no recorder account. To log your records, deploy the contract and create a recorder key as `contracts/README.md` describes, then run `scripts/record-receipt.mjs` with your own account. Nothing is published either: no preview leaves your machine unless you set `VERCEL_TOKEN_FILE`. Everything a solo line makes is kept under `.solo/`, which git ignores, so the committed record stays as it is.

## Built during the hackathon

- **First commit:** 12 November 2026, 13:55 CET. Every commit in this repository is dated 12 to 14 November.
- **What existed before:** Cambrian's private system, written from 3 November, and three builds of Upread it made on 9 November. Those three records are imported here and labelled as imported; the converter that read them is not published.
- **What this repository added during the hackathon:** the open build path ported from the private one; passkey approvals by a council of any size; the conversation that drafts a brief; the receipt contract, deployed and locked on NEAR mainnet; the judge; solo mode; the hosted replay; the stake; and the two products built here on 14 November.
- **One thing to know about the history:** on the evening of 12 November the first day's work was rebuilt into ten commits, one per pull request, each keeping the date its piece was written. Everything after that is as it was pushed. `HACKATHON.md` has the longer account.

## What is live today, and what is next

Live today:

- The path from a signed brief to a checked build: passkey signatures verified before anything runs, a sealed workspace, every model call priced through NEAR AI and stopped at the signed budget, the brief's checks, and a record with a hash. It is covered by the tests and the judge, and was exercised in rehearsal builds with a test council.
- The replay: the two builds above, and three earlier builds of Upread made on Cambrian's private setup on 9 November (one failed, two passed, $5.36 in total). Those three are imported with their numbers unchanged and labelled as imported.
- The council: all three members enrolled a passkey on 13 November (`data/council.json`). Clemens and Michael have signed briefs; JJ has not signed one yet.
- Two builds signed by the council, 14 November. Each brief came out of a Talk conversation with Clemens, was signed by Clemens and Michael with passkeys (2 of 3), and was built by `anthropic/claude-opus-5-5` through NEAR AI Cloud in a sandbox. Both passed every check on the first attempt.
  - **Upread Mini**, a reader that shows a text one word at a time: 2 min 44 s, 9 model calls, $0.43 of a $1 budget. [Preview](https://cambrian-upread-mini-crnw8wneo-cambrian-collective.vercel.app) · [record](https://cambrian-line-replay.vercel.app/#/receipts/upread-mini-086cdf) · [on NEAR](https://nearblocks.io/txns/CmFEiKKFuREVvmosTFMqiarbrekGyCSFHz2NnduWqBmv)
  - **Postmark**, London postcards that unlock only within 150 m of the landmark: 4 min 4 s, 11 model calls, $0.66 of a $1.50 budget. [Preview](https://cambrian-postmark-m2x6yxrfp-cambrian-collective.vercel.app) · [record](https://cambrian-line-replay.vercel.app/#/receipts/postmark-6ee0a5) · [on NEAR](https://nearblocks.io/txns/4wYmP1KUzFGkz8dhWQAgnW1Q7Y3dsswhJDRofLf1F5Hz)
  - All 20 build calls are signed by NEAR AI's attested gateway and verify offline (`npm run judge`, check 8). The two briefs were drafted by `deepseek-ai/DeepSeek-V4.1-Flash-1017` for $0.006 and $0.008. Their responses are signed over the exact request and response, but NEAR AI's report showed no TEE for the key that signed, so they are not verified as model-signed here (judge check 5 says so and skips).
- The stake: the collective's account, `cambriancollective.near`, staked 3,045 NEAR into NEAR AI on 13 November ([transaction](https://nearblocks.io/txns/9US5CcTaSYiX2DS7pGLWoS4sYpBZ4s9BvSEq1CgoJ6eo)). NEAR AI's estimate on that date: about $60 a month in credits. No credits received are recorded yet.
- On NEAR: the contract that logs a build record's hash is deployed on mainnet and locked. Five records are logged through it: the two council-signed builds (14 November) and the three imported Upread builds (13 November, logged to prove the recorder and the check). `npm run judge` check 16 re-reads all five.

Next, and not true yet:

- The stake is held by the collective's account, not by its treasury. The Sputnik DAO treasury, `cambrian.sputnik-dao.near`, is set up, and NEAR AI confirmed that a DAO cannot be bound as a funding wallet yet; that needs changes in Trezu, Sputnik DAO and NEAR AI.

- No build here has failed yet, so the learning loop has not run on this repository's own builds: no lesson has been drafted from one and no member has signed one. The eight lessons in force were carried over from Cambrian's private setup; two of them changed both briefs.
- No NEAR AI credits from the stake are recorded. The staking contract shows the collective's position as active with 3,045 NEAR; NEAR AI's credit balance cannot be read with an API key. Nothing here says the stake paid for a build: both builds were paid from the NEAR AI account's existing balance.
- The one thing the line learns next: products that talk to Cambrian Mini, for shared data and for model calls paid from the stake. That unlocks Spot, a persona generator, and signed postmarks on NEAR.
- Contribute the line's redacted build traces through NEAR AI Gateway, so the factory's own failures and fixes earn inference credits.
- Upread, as first built on the private setup, has no public link. Upread Mini does.
- A collective larger than the founding council of 3 and the on-chain council are not built.

The longer list is under [Honest limits](#honest-limits). This repository was written 12–14 November 2026 for NEAR HACKATHON; the build path was ported from Cambrian's private setup (built 3–10 November), which built Upread.

## Try it

Needs Node 22 or newer and git. No keys, no account, no dependencies to install.

```sh
git clone https://github.com/Cambrian-Studio/cambrian-mini && cd cambrian-mini
npm ci
```

**1. `npm test`** — unit tests and attack tests. Expect the last line:

```
287 passed, 0 failed
```

On macOS the last line is `286 passed, 0 failed, 1 skipped (each prints its reason above)`: the skipped test is the bubblewrap wall, which exists on Linux only.

**On Linux the sandbox needs unprivileged user namespaces.** Install bubblewrap first (`sudo apt-get install bubblewrap`). Bubblewrap can only build its sandbox where the kernel lets an ordinary user create a namespace. A default Docker container does not, and neither does Ubuntu 24.04 until you run `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` (CI does exactly that, in `.github/workflows/ci.yml`). Without it nothing is broken, but the build path refuses to run anything it cannot wall in, and you see this instead of the lines in this section:

```
276 passed, 0 failed, 11 skipped (each prints its reason above)        npm test
judge: 17 checks — 15 ok, 2 skipped, 0 failed                          npm run judge
state     blocked — no sandbox on this machine (bwrap is installed but cannot create a namespace here; …)   npm run demo
```

To get the full run in a container, give it the namespaces:

```sh
docker run --rm -it --privileged -v "$PWD":/src:ro node:22-bookworm sh -c \
  'cp -r /src /work && cd /work && apt-get update -qq && apt-get install -y -qq bubblewrap && npm ci && npm test && npm run judge && npm run demo'
```

If bubblewrap is not installed at all, the reason reads `bwrap is not installed` instead. Both sets of lines were taken on 14 November in `node:22-bookworm`: the first without `--privileged`, the second with it.

**2. `npm run judge`** — re-derives the claims on your machine with no keys; checks 16 and 17 read NEAR mainnet and skip without a network. Expect 17 numbered lines, each with a detail after a dash; these twelve and the summary, shortened here to their titles:

```
 1. [ok] the committed contract wasm is the one SHA256SUMS names — sha256 3e547da4f94b14de…
 2. [ok] the council file names its members and a threshold of at least two
 3. [ok] receipts rebuild from the run records
 4. [ok] recorded approvals verify (2 of 3 passkeys)
 6. [ok] kept build output passes its checks again
 7. [ok] a NEAR AI response signature verifies offline, and a changed byte does not
 8. [ok] recorded model calls carry verifying signatures
10. [ok] the line runs a ticket end to end offline
11. [ok] attack: unapproved, 1-of-3 and altered tickets are refused
12. [ok] the threshold is a parameter: a council of 7 with threshold 4 releases at 4, refuses at 3, refuses an altered brief
13. [ok] attack: the push guard refuses main, a forced push and a + refspec; it accepts build/<ticket-id>
17. [ok] on chain: the stake position named in data/stake.json is there, with that amount
judge: 17 checks — 16 ok, 1 skipped, 0 failed
```

`[skip]` means "could not be observed here", with the reason on the line; it is never counted as ok. `[FAIL]` exits non-zero. The one skip today is check 5: both recorded briefs carry a model signature that verifies over the exact request and response, but NEAR AI's report shows no TEE for the key that signed, so the TEE half is not shown.

**3. `npm run demo`** — one ticket through the real line with a stand-in agent and a throwaway test council. Expect, near the end:

```
state     green-no-preview
pushed    refs/heads/build/facts-page-1 @ <commit>; main untouched
recheck   7 of 7 file checks pass again from the kept output (3 run checks skipped)
receipt   sha256 <64 hex>
```

Add `--approvals 1` (`node line/run-cli.mjs --offline --ticket test/line/fixtures/tickets/facts-page-1.json --approvals 1`) and expect `state     refused — not released by the council: 1 of 3 valid approvals; 2 are required. Nothing ran.`

**4. `npm start`** then open `http://localhost:8787/` — the app. With no key file it says `REPLAY mode` and shows the recorded runs. Open **Verify**, pick a build, press **Verify this receipt**: the browser recomputes the sha256 over the receipt's canonical JSON and shows `Hash matches.`. (This proves the browser and the server serialise and hash the receipt identically; it becomes tamper evidence once the hash is also recorded somewhere the server cannot change.) Open **The line** and press **Replay** on a run to watch its stations. Every button that would spend or sign explains what it would do instead of doing it.

**5. The contract, executed** (no Rust needed): `node --test test/near/verify-wasm.test.mjs` runs the committed 1.8 kB wasm itself with stub host functions → `pass 9`, `fail 0` (prefixed `ℹ` in a terminal, `#` when piped).

## Treasury and council

Cambrian separates two decisions. Members' capital sits in a Sputnik DAO treasury (cambrian.sputnik-dao.near, managed through Trezu), controlled by those who contribute NEAR. What gets built is decided by the council, which signs briefs with passkeys, so creatives need no wallet. We set out to fund NEAR AI compute directly from the DAO. NEAR AI confirmed that a DAO cannot yet bind as a funding wallet: the ownership signature it requires is something a contract account cannot produce, and a fix needs changes in Trezu, Sputnik DAO and NEAR AI. Until then, the collective's account cambriancollective.near stakes into NEAR AI. Next: the treasury stakes directly once DAO binding exists, and council approvals move on chain as DAO proposals.

## The loop

1. **Idea → brief.** A member types an idea (`web/screens/talk.js`). On the hosted app only an enrolled council member can, with a passkey signature over the idea. In LIVE mode one NEAR AI call (a second if the first draft is refused) drafts a brief: title, goal, acceptance checks, out of scope, budget in dollars. The brief is written by an open model NEAR AI hosts inside a TEE (`deepseek-ai/DeepSeek-V4.1-Flash-1017`); the call's signature and exact bytes are kept beside the ticket, and the ticket carries the response hash. Code, not the model, decides what stands: the draft is parsed as a ticket, clamped to the budget rules and linted against every lesson (`tickets/brief.mjs`, `lessons/lessons.mjs`).
2. **Approval.** Members propose; a quorum of the collective signs. Each signer signs the ticket's hash with a passkey, and that hash covers the hash of the model response the brief came from. Today the collective's signers are a founding council of 3 with a threshold of 2. The threshold is a parameter of `data/council.json` (N members, M signatures, never below 2): the same code releases a 7-member council at 4 signatures, and the judge runs that case. How a collective of 100 or more decides (quorum by role, weighting, an on-chain council via Trezu) is next, not built. At the threshold the ticket is released (`approvals/release.mjs`); the signatures are stored with the ticket.
3. **Build.** The line (`line/run.mjs`) checks the signatures itself, then runs a coding agent (OpenCode) inside a sandbox. The agent's only door to a model is a bridge (`line/kit/bridge.mjs`) that prices every call and stops at the ticket's budget. Builds run on the model named in `LINE_MODEL` through NEAR AI Cloud, at most $2 a build. The default is `deepseek-ai/DeepSeek-V4.1-Flash-1017`; a solo line uses `Qwen/Qwen3.6-35B-A3B-FP8`; the council's build machine is set to `anthropic/claude-opus-5-5`. Calls to an open model NEAR AI hosts are signed inside its TEE; calls NEAR AI routes to an outside provider, such as the Anthropic model, are signed by NEAR AI's attested gateway, not by the model.
4. **Test.** The ticket's checks run on a fresh clone, inside the sandbox. RED twice: nothing leaves the machine.
5. **Preview.** GREEN: the commit is pushed to `build/<ticket-id>` and the output is deployed to a Vercel preview.
6. **Receipt.** The run record becomes a receipt with a sha256 (`receipts/receipt.mjs`). That hash is what the receipt contract is for; recording it is a manual command today; the three imported records are on mainnet (see the limits).
7. **Lesson.** On RED (not on a refused or blocked run), Cambrian drafts one rule from the failure; it becomes a rule only when a council member accepts it with a passkey; the next brief is then linted against it (`lessons/draft.mjs`, `lessons/store.mjs`).

### A conversation first

Talk to Cambrian starts as a conversation, not a form. Cambrian discusses the idea, pushes back, asks at most two questions a turn and proposes what to cut; the answer is streamed, and nothing is a brief yet (`tickets/think.mjs`). When the member says it is ready or presses "Draft the brief", the brief is drafted from the conversation. Each further instruction ("simpler", "drop the login") makes a new draft version with its changes listed. Every draft is checked against the accepted lessons, and a draft that breaks one is shown with the rule and cannot be sent. "Send to council" puts that exact brief in Approvals. The brief names the conversation by hash, so every signature covers the conversation that shaped it, and the conversation is kept with the brief. Thinking turns and drafts run on the brief model and are paid from the same caps as builds. If NEAR AI answers that the brief model is overloaded, fails or does not answer in a minute, the next open model it hosts is asked (`Qwen/Qwen3.6-35B-A3B-FP8`), and the brief names the model that wrote it.

There is still one input and no mode to choose. The brief model reads each message from an enrolled member with the built products and their builds as context and names it: a new product, a revision of an existing product (a design pass, a fix or a feature), or a question (`tickets/intent.mjs`). The model proposes and the code decides: a revision must name a product that is on record, or the member gets one short question back.

- **Revision.** A revision brief carries a `revision` field: the build it revises, the kind of change, and who asked. The field is part of the ticket, so the council's signatures cover it. The member's notes become the brief's checks. The council signs it like any brief, and the build starts from the commit of the build it revises instead of from main (`line/run.mjs`). The product page and the receipt then say "Design pass by JJ · v1 → v2" with both previews linked.
- **Images.** A member can attach up to 3 images to a message: PNG or JPEG, under 5 MB each. The passkey signature covers the text and each image's sha256. The files are kept beside the brief on the build machine and named in the brief by hash. They are not sent to a model, not served by the app and not committed.
- **Taste note.** A council member can add a note of up to 200 characters when signing. The signature covers the brief's hash and the note together, so a note cannot be added, changed or removed later (`approvals/release.mjs`).
- **House kit.** Every build's workspace gets the same design rules and tokens (`line/kit/house`), and the builder is told to read them first. The kit's hash is written on the run record.

## NEAR features used

| Feature | How it is used | Status |
|---|---|---|
| NEAR AI Cloud inference | Every model call goes to `https://cloud-api.near.ai/v1`; cost per call is NEAR AI's `/v1/models` price × the usage the call reports (`near/nearai.mjs`). | built, tested; exercised live in rehearsal builds |
| NEAR AI response signatures and TEE attestation | Two levels, and the receipt says which. **Model-signed:** the brief is written by an open model inside a GPU TEE, and its response is signed inside that TEE. **Gateway-signed:** build calls go to a model NEAR AI routes to an outside provider; NEAR AI's attested gateway signs `sha256(request):sha256(response)` for each call, which shows what was relayed, not where the model ran. Signatures, the hashes they bind and the Intel TDX quote chain are verified offline (`near/nearai.mjs`, findings in `near/ATTESTATION.md`). | built, tested on recorded real responses; exercised in rehearsal builds |
| Receipt contract | Raw Rust, no SDK, 1.8 kB: one method, `record_receipt(32 bytes)`, that emits one event log. No state, no deposit (`contracts/receipts`). A receipt is "on NEAR" when a transaction signed by the recorder account logged its hash; `scripts/verify-receipt.mjs` checks that with read-only RPC calls (`node scripts/verify-receipt.mjs --onchain data/runs/<build>/onchain.json`; it reads the archival node named in `data/chain.json`). | deployed on mainnet and locked; three imported records logged |
| Function-call access keys | The recorder signs with a key limited to `record_receipt` on the receipt contract and refuses a full-access key (`near/record.mjs`). | in use on mainnet: the recorder account holds only this key |
| Staking | The Stake screen shows the stake, its account and transaction, and NEAR AI's published staking-for-inference formula as separate facts (`data/stake.json`). | recorded: 3,045 NEAR from the collective's account, with its transaction; credits received not recorded |
| The two accounts | The contract account and the one recorder account are written in `data/chain.json`. Both are implicit accounts (64 hex characters), not named ones. The recorder's signature is what gives a logged hash its meaning. | on mainnet |
| Sputnik DAO approval via Trezu | The 2-of-3 approval as an on-chain DAO vote (`approvals/dao.mjs`). | **not built**: a stub that says so. No code here reads or votes on the DAO; the treasury exists on mainnet and that is all |

## Claims

Every claim, its `file:line`, its test and its status are in [CLAIMS.md](CLAIMS.md), including the ones that are not true yet. `test/docs/claims.test.mjs` fails if a reference there does not exist. The invariants and what enforces each are in [AGENTS.md](AGENTS.md).

## Honest limits

- **What is on chain, and what it proves.** The receipt contract is on NEAR mainnet at `b9d43a067f9063ac38b7adcbbdf900eb7841b82adef3de31ae0e21d4b64f6de2`. Its account has no access key, so the code cannot be changed. It is log-only: anyone can call it and log any hash, so a record counts only when its transaction was signed by the recorder account `3c069c3562504d0f23a23bd967d2ef95fa6f1334a8b2274359f6fd34599102cb`, which holds one key limited to `record_receipt`. The three Upread records were logged on 13 November, each labelled "imported from the private line, recorded 13 Nov": they prove the recorder and the check work, and that those records have not changed since. They do not prove anything about how those builds were approved or run. Ordinary nodes forget transactions after a few days, so `data/chain.json` names a public archival node for the check.
- **On-chain approval is next, not now.** Approval today is 2 of 3 passkey signatures checked by this code. The Sputnik DAO vote is a stub.
- **One stake, made after the recorded builds.** `data/stake.json` holds one stake: the collective's account staked 3,045 NEAR into NEAR AI on 13 November. The three recorded builds ran on 9 November, so this stake did not pay for them. The $60 a month is NEAR AI's estimate, not credits received. The treasury (`cambrian.sputnik-dao.near`) holds no stake: NEAR AI confirmed a DAO cannot be bound as a funding wallet yet. The stake does not by itself pay for builds; inference is paid in NEAR AI credits, and the Stake screen shows the stake and the spend as separate facts.
- **What is replay.** The hosted demo and `npm start` without a key show recorded runs. The three Upread runs were built on Cambrian's private line on 9 November and imported here by a converter that is not published, because it has to name the private record's fields to read them. `test/import/committed-runs.test.mjs` checks the result. They were approved there by one council member's passkey; that signature is not in this repository and is not verifiable from it. They used a different model (`anthropic/claude-opus-5-5`, as their records say), captured no signatures, and their dollars are the private line's own rate table times reported usage, not this repository's pricing. Their two GREEN runs say `green-preview` because the private line made previews; those previews sat behind a sign-in, so no address is shown.
- **The collective is three people today.** "The collective signs" means, today, 2 of a founding council of 3. A larger collective deciding by quorum is a parameter away in code and not yet a fact.
- **Two of the three council members have signed.** `data/council.json` holds one passkey for each member, enrolled on 13 November. Clemens and Michael signed both briefs on 14 November from their own devices; JJ is enrolled and has not signed yet. `npm run judge` check 4 re-verifies the four signatures.
- **Why `data/council.json` names a host.** A passkey is bound to the site it was created on. The council's passkeys were created on the build machine's address, `cambrian-mini.tail176671.ts.net`, so that name is the passkey site (the WebAuthn relying party) and is part of what each signature covers. It is an address, not a secret. Changing it would invalidate the three enrolled passkeys.
- **The walls differ by platform.** macOS: `sandbox-exec`. Linux: bubblewrap with `--unshare-all` (a new, empty network namespace, so no network at all; the bridge is reached through a unix socket), or a `--network none` container. The container fallback has never been executed. With no sandbox, the line only replays.
- **Attestation has an online half we do not check.** Intel TCB status, GPU evidence and image provenance need online verifiers; the judge reports them as skipped.
- **Costs are as reported.** For runs of this line, a call's dollars are NEAR AI's published price times the token usage NEAR AI reports for that call. We do not independently measure usage. A ticket's dollar budget is checked before each call, so the call in flight when it is reached still completes.
- **The eight starting lessons were carried over, not accepted here.** They come from the private line; three of them have no single run behind them. No lesson has yet been drafted from a RED run of this line and accepted by passkey.
- **The judge and the demo are keyless, not network-free.** The stand-in build's install step may reach `registry.npmjs.org` through the line's allow-listed tunnel. They have not been run with the network off.
- **The enrolment trusts the browser for the public key.** A passkey's public key is taken from the browser at enrolment, behind a one-time invite; the attestation statement of the authenticator is not checked.
- **Revisions, images and taste notes are tested, not yet used.** The conversation, the draft and the hand-over to the council were used for both real briefs, and both builds got the house kit. No member has yet revised a product, attached an image or added a taste note; those are proven by tests with a stand-in model and a test council. Attached images are kept but no screen shows them, and the builder does not see them. No check enforces that a build followed the house kit. A revision can only be built when the build it revises was made by this repository's build path.
- **No build here has failed yet.** Both council-signed builds passed on the first attempt. The path from a failed build to a lesson a member signs, and to the next brief being checked against it, is covered by tests and has not run on a real build of this repository.
- **Postmark's fence is in the page.** The page opens a landmark only within 150 m of it, and has no switch around that: its seven node tests pass, and driven in a browser from 151 m away or with debug or bypass words in the address it stays closed. The position comes from the member's device, and a device can report a false one.

## Repository map

```
app/         the server (REPLAY and LIVE), the record → JSON snapshot, the static demo builder
web/         the UI: Home, Watch a build, Products, Verify; Talk, Approvals, Lessons and Stake open from those
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
