# For agents working in this repository

These hold whatever you change. Each names the code that enforces it and the test that fails if it stops holding. Run `npm test` and `npm run judge` before proposing any change.

| Invariant | Enforced by | Test that fails if it breaks |
|---|---|---|
| The line never pushes to main, never forces, and pushes only `build/<ticket-id>`. (A product's local repository gets its one empty first commit on main when the line creates it.) | `line/github.mjs` `pushGuard`, `pushBranch` | `test/line/push-guard.test.mjs`; `test/line/e2e-offline.test.mjs` "a GREEN run that asks to push main, or to force, ends RED" |
| Nothing is built without the council's threshold of valid signatures over the ticket's hash (today 2 of 3; the threshold is never below 2). | `approvals/release.mjs` `verifyRelease`, called in `line/run.mjs` at the start and before the push | `test/approvals/release.test.mjs`; `test/line/release.test.mjs` |
| A ticket altered after signing is refused. | the challenge is derived from `sha256(canonical(ticket))` in `approvals/release.mjs` | `test/line/release.test.mjs` "a ticket altered by one byte" |
| Agent and product code run only inside the wall; with no sandbox nothing runs. | `line/kit/sandbox.mjs`, `line/kit/agent.sb`, `line/kit/in-sandbox.sh`; the probe `line/kit/line-probe.sh` before every attempt | `test/line/sandbox.test.mjs` |
| The agent reaches only the model bridge and `registry.npmjs.org`. | `line/kit/bridge.mjs` (allow-list tunnel), the sandbox's network rules | `test/line/bridge.test.mjs` "the tunnel"; the probe test |
| A ticket stops at its budget (the call in flight when the figure is reached still completes); a day stops at the cap, $5 unless the operator raises it. Briefs and lesson drafts count toward the same cap. The app releases no build above $2 and stops everything at $15 in total. | `tickets/ticket.mjs` (ticket cap), `line/budget.mjs` `ceilingDecision`, `line/kit/bridge.mjs` (per-call stop) | `test/line/ticket.test.mjs`; `test/line/budget.test.mjs`; `test/line/bridge.test.mjs` |
| A model without a published price is never guessed: no run starts on one, and the bridge closes after the first call it cannot price. | `line/run.mjs` (preflight), `line/kit/bridge.mjs` | `test/line/bridge.test.mjs` "a model with no price fails closed" |
| No secret in code, logs, git or the UI. Keys are read from mode-600 files at use time. | `near/nearai.mjs` `readKey`, `line/kit/bridge.mjs`, `.githooks/pre-commit` (gitleaks), `app/static-build.mjs` (output scan) | `test/line/bridge.test.mjs` "the key never reaches the agent side or any log"; `test/near/nearai.test.mjs`; judge check 15 |
| A check that could not look is a skip or a failure, never a pass. | `line/checks.mjs` (`unverified`), `scripts/judge.mjs`, `scripts/check-wasm.mjs` | `test/near/rpc-codehash.test.mjs` "no wasm yet is a skip, never a pass" |
| A receipt is a pure function of the run record, and every fact it carries moves its hash. | `receipts/receipt.mjs`, `receipts/canonical.mjs` | `test/receipts/receipt.test.mjs` "what the receipt carries, and what it leaves out" |
| Lessons are appended, never rewritten. | `lessons/store.mjs` `acceptLesson` | `test/lessons/store-and-draft.test.mjs` |
| The app listens on 127.0.0.1; REPLAY never spends or signs; no file outside `web/` is served. | `app/config.mjs`, `app/server.mjs` | `test/app/server.test.mjs`; `test/app/hardening.test.mjs` |
| Mainnet is never signed without an explicit human flag; a full-access key is never used. | `near/record.mjs` | `test/near/record.test.mjs` |
| Every claim in CLAIMS.md points at code and a test that exist. | `test/docs/claims.test.mjs` | itself |

Rules of the house:

- Never deploy a contract, sign a transaction, make anything public, or raise a spend cap. Those are human decisions; stop and ask.
- No runtime dependencies. `node:` builtins only.
- A test proves both directions: it accepts the good case and refuses the bad one.
- When something is not true yet, add a `pending` row to CLAIMS.md rather than wording around it.
- `data/` is the record. Do not edit a run record by hand; re-import or re-run.
