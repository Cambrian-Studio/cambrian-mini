# Cambrian Mini

A short account for a reader in a hurry. Every claim links to where it can be checked. The longer versions are in [`README.md`](README.md) and [`CLAIMS.md`](CLAIMS.md).

## What Cambrian is

Cambrian Mini is a system in which a small group of people, a council, approves a written description of a product, a brief, by signing it with passkeys. When enough of them have signed, an AI coding agent builds the product in a sandbox with a fixed budget. Every build leaves a record of each model call, what it cost and which checks passed, and the hash of that record is logged on NEAR mainnet, where anyone can check it.

## What this repository is, and is not

- It is what we built for NEAR HACKATHON. Cambrian is a product studio governed by its members. One Node app with no runtime dependencies ([`package.json`](package.json)).
- Every commit is dated 12, 13 or 14 November 2026. What was reused from Cambrian's private system is listed in the README under [Built during the hackathon](README.md#built-during-the-hackathon).
- It is not Cambrian's private system. Three earlier builds from that system are kept here as imported records, labelled as such, because the lessons came from them ([Where the lessons came from](README.md#where-the-lessons-came-from-earlier-builds-on-cambrians-private-system)).
- It is not decentralised today. Approval is 2 of 3 passkeys checked by our code on our machine. The DAO vote is not built ([Trust model](README.md#trust-model)).

## What ran

Two products were built here on 14 November. Each brief came out of a conversation, was signed by two of the three council members with passkeys, and passed every check on the first attempt ([`data/runs`](data/runs)).

- **Upread Mini** reads a text one word at a time. 2 min 44 s, 9 model calls, $0.43 of a $1 budget. [Open it](https://cambrian-upread-mini-crnw8wneo-cambrian-collective.vercel.app) · [its record](https://cambrian-line-replay.vercel.app/#/receipts/upread-mini-086cdf) · [the hash on NEAR](https://nearblocks.io/txns/CmFEiKKFuREVvmosTFMqiarbrekGyCSFHz2NnduWqBmv)
- **Postmark** makes London postcards that unlock only within 150 m of the landmark. 4 min 4 s, 11 model calls, $0.66 of a $1.50 budget. [Open it](https://cambrian-postmark-m2x6yxrfp-cambrian-collective.vercel.app) · [its record](https://cambrian-line-replay.vercel.app/#/receipts/postmark-6ee0a5) · [the hash on NEAR](https://nearblocks.io/txns/4wYmP1KUzFGkz8dhWQAgnW1Q7Y3dsswhJDRofLf1F5Hz)
- All 20 build calls are signed by NEAR AI's gateway and the signatures verify offline (`npm run judge`, check 8). Both briefs are signed inside the model's TEE and verify offline (check 5) against a TEE report fetched about twelve hours after the calls. That shows the signing key is in a TEE now, not that it was at the moment of the call.
- The contract that logs the hashes is on mainnet and locked: [`b9d43a06…`](https://nearblocks.io/address/b9d43a067f9063ac38b7adcbbdf900eb7841b82adef3de31ae0e21d4b64f6de2), source in [`contracts/receipts`](contracts/receipts). Five build records are logged through it: these two and the three imported ones (`npm run judge`, check 16).
- Eight lessons were in force, carried over from the earlier builds. Two of them changed both briefs ([`lessons/`](lessons)). No build here has failed yet, so no lesson has been learned from this repository's own builds.

## The capital

- We staked our own capital first: 3,045 NEAR, about €10,000 when staked on 13 Nov, with NEAR AI. [The stake transaction](https://nearblocks.io/txns/9US5CcTaSYiX2DS7pGLWoS4sYpBZ4s9BvSEq1CgoJ6eo). `npm run judge` check 17 reads the position from mainnet. The euro figure is the collective's own, its value at purchase.
- Credits earned $1.86 · NEAR AI reports $60.90 a month, [as reported by NEAR AI](web/assets/evidence/nearai-farmed-20261114.png) on its dashboard on 14 Nov. A statement of those figures is in [`data/credits-statement-20261114.json`](data/credits-statement-20261114.json) and [its hash is logged on NEAR](https://nearblocks.io/txns/GW6BSjHUEVVKzQMtNUBX9RnBCQVYfJhx3HJo5qr3j7ii). We cannot read this figure with an API key, so no command checks it.
- No build so far was paid from the stake. The account also holds credits we bought, and which credits paid for which call is not recorded ([`data/stake.json`](data/stake.json)).
- The two builds cost $1.09 in model calls together, the sum of their records ([`data/runs`](data/runs)).

## Why NEAR

- **Staked NEAR becomes compute.** The collective staked 3,045 NEAR with NEAR AI ([the stake transaction](https://nearblocks.io/txns/9US5CcTaSYiX2DS7pGLWoS4sYpBZ4s9BvSEq1CgoJ6eo)), and the stake earns NEAR AI credits: $1.86 by 14 Nov, at $60.90 a month, [as reported by NEAR AI](web/assets/evidence/nearai-farmed-20261114.png) ([the statement's hash on NEAR](https://nearblocks.io/txns/GW6BSjHUEVVKzQMtNUBX9RnBCQVYfJhx3HJo5qr3j7ii)). The NEAR stays staked. No build so far was paid from the stake.
- **Every build record is public, timestamped and checkable.** The hash of each record is logged on NEAR mainnet by one recorder account through a contract whose code cannot change. `node scripts/verify-receipt.mjs --onchain data/runs/postmark-6ee0a5/onchain.json` reads mainnet with no key and checks ten things about that transaction. What the chain does and does not show is under [Trust model](README.md#trust-model).
- **NEAR AI's gateway signs every build call.** All 20 model calls of the two builds carry the gateway's signature, and each verifies offline (`npm run judge`, check 8). The conversation turns before a brief are priced and not signed.
- **The briefs are checked against NEAR AI's TEE reports.** Each of the two briefs is signed by a key inside the model's TEE. Checked, offline, on 14 November (`npm run judge`, check 5): the signature over the brief, and the Intel signature chain of the TEE report that names the signing key. The reports were fetched on 14 November at 11:48 UTC, about twelve hours after the calls, so they show the key is in a TEE now, not that it was at the moment of the call. Not checked: that the measured software is a build NEAR AI published, the platform's patch level, and the GPU evidence ([Known limits](README.md#known-limits)).
- **Not on chain yet: the council.** Who the members are, their keys and the 2 of 3 rule are in `data/council.json`, a file in this repository, and approvals are checked by our code. A council on chain is next, and is not built ([what is next](#what-is-next)).

## How to verify in five minutes

1. **The replay.** Open <https://cambrian-line-replay.vercel.app/#/verify>, pick a build and press **Verify this receipt**. Your browser recomputes the sha256 of the record.
2. **The judge.** `git clone`, `npm ci`, `npm run judge`: 17 checks with no keys, about 5 s, ending `judge: 17 checks — 17 ok, 0 skipped, 0 failed`. In a plain Linux container it ends `16 ok, 1 skipped, 0 failed`, and the skip prints its reason ([Try it](README.md#try-it)).
3. **One record on chain.** This reads mainnet with no key and ends `[ok] receipt c38e49f1… was recorded by 3c069c35… in tx 4wYmP1KU…`:

   ```sh
   node scripts/verify-receipt.mjs --onchain data/runs/postmark-6ee0a5/onchain.json
   ```

4. **Your own build.** `NEARAI_KEY_FILE=/path/to/your-nearai.key npm run solo` with your own NEAR AI key: talk an idea through, sign the brief as a council of one, watch it build. Measured on 13 November from `git clone` to the first preview: 57 s and $0.015 ([Run your own line](README.md#run-your-own-line)).

## Trust model and known limits

- What anyone can check without trusting us: the contract's code and that it cannot change, the five logged hashes and who signed them, that each record hashes to its logged value, that the approvals are valid passkey signatures by the keys in [`data/council.json`](data/council.json), and the stake.
- What you have to trust: the one build machine and its operator, the council file, the page a member signs on, the recorder key holder, NEAR AI's reported token counts and prices, and the hosting provider. The chain shows that a hash existed at a time. It does not show that the record is true. The full list is under [Trust model](README.md#trust-model).
- An independent security review on 14 November found limits we did not fix. They are listed, not hidden, under [Known limits](README.md#known-limits).

## What is next

None of this is true yet ([What is live today, and what is next](README.md#what-is-live-today-and-what-is-next)).

- The stake held by the treasury, `cambrian.sputnik-dao.near`, in place of the collective's account. NEAR AI confirmed a DAO cannot be bound as a funding wallet yet.
- Products that talk to Cambrian Mini, for shared data and for model calls paid from the stake.
- A lesson drafted from a failed build here and signed by a member.
- A collective larger than the founding council of 3, and the council on chain.

## The team

- Clemens: Founder.
- JJ: Design.
- Michael: Engineering.
