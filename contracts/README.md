# Receipts contract (log-only)

A NEAR contract with one method and no memory of its own:

```
record_receipt(<32 raw bytes: the sha256 of a receipt>)   →   one log line, nothing else
```

- **Log-only.** The call emits one event log and returns. The contract writes no storage, calls no
  other contract and returns no value.
- **No state.** There is no owner, no allow-list, no counter and no `init`. Nothing can be
  configured, so nothing can be misconfigured or changed later through the contract.
- **No deposit.** A call that attaches any deposit panics (`record_receipt: no deposit`).
- **Anyone can call it.** See "What it does NOT prove" below: this is deliberate, and it matters.

**Deployment status: not deployed. The owner creates and funds the account.** Nothing in this
repository deploys the contract, creates an account or key, or sends a transaction on its own.

## Why this shape

It is the cheapest honest thing: a receipt hash in the log of a transaction that a named recorder
account signed. The chain already records who signed a transaction, what its arguments were and
what it logged, and keeps that under its own consensus. A contract that stored the hashes again
would add storage cost, an owner key to protect and code to trust, and would prove nothing more.

A record is therefore not something inside the contract. **The record is the transaction**:

| Part of the record | Where it lives |
| --- | --- |
| who recorded it | the transaction's `signer_id` |
| what was recorded | the FunctionCall args: the 32 bytes of the hash |
| that the contract accepted it | the outcome's status and its one log line |
| when | the block the transaction is in |

## The method

Source: [`receipts/src/lib.rs`](receipts/src/lib.rs). `#![no_std]`, no SDK, no allocator, no
dependencies. It imports six host functions from the module `env` (`input`, `register_len`,
`read_register`, `attached_deposit`, `log_utf8`, `panic_utf8`) and exports one function.

`record_receipt` panics when

- the attached deposit is not zero (`record_receipt: no deposit`);
- the input is not exactly 32 bytes (`record_receipt: input must be exactly 32 bytes (the receipt sha256)`).
  The hex text of a hash (64 bytes) and JSON are both refused: the args are the raw bytes.

Otherwise it logs exactly one line, a NEP-297 event, with the hash as 64 lowercase hex characters:

```
EVENT_JSON:{"standard":"cambrian-receipt","version":"1.0.0","event":"record_receipt","data":[{"sha256":"<64 hex>"}]}
```

## What it does NOT prove

- **The contract does not prevent a stranger from logging any hash.** Anyone with a NEAR account can
  call `record_receipt` with any 32 bytes, and the same hash can be logged many times. A log line
  by itself means nothing.
- **A reader trusts a record only when its transaction was signed by the expected recorder
  account.** That check is made by the reader (`scripts/verify-receipt.mjs --signer <account>`),
  not by the contract. Which account is "the expected recorder" has to be known from somewhere the
  reader trusts; a file that sits next to the receipt can name any account.
- It does not prove what the 32 bytes are a hash of, or that the receipt behind them is true. It
  proves that this account put these bytes on the chain in that block.
- There is no list of receipts and no "get": a contract without state has nothing to answer a view
  call with. Finding a record needs its transaction hash (kept in `onchain.json`, see below).
- Ordinary RPC nodes forget transactions after a few days. Reading an old record needs an archival
  node (`--rpc-url`). The record is still on the chain; the default public node just no longer
  serves it.
- The code-hash check compares the account's code **now** with the committed wasm. An account whose
  owner still holds a full-access key can deploy other code later.

## Build

```sh
contracts/build.sh
```

Needs `rustup` and nothing else (no docker; the crate has no dependencies to download). With
Homebrew, `brew install rustup` is enough: the script finds it and calls the pinned toolchain by
path, so a separately installed `rust` does not get in the way.

| | |
| --- | --- |
| Compiler | rustc 1.99.1, pinned in `receipts/rust-toolchain.toml`, target `wasm32-unknown-unknown` |
| Flags | `-C target-cpu=mvp -C link-arg=-zstack-size=16384` (`receipts/.cargo/config.toml`) |
| Profile | `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true` |
| Command | `cargo build --release --locked`, after `cargo clean` |
| Output | `contracts/receipts.wasm` and its checksum in `contracts/SHA256SUMS` |

`target-cpu=mvp` keeps the module to WebAssembly 1.0 instructions. Newer compilers otherwise emit
bulk-memory, sign-extension and similar instructions, which a NEAR node may refuse when the contract
is deployed. The test suite reads every instruction in the committed wasm and fails on any that is
not WebAssembly 1.0.

The committed wasm is 1,767 bytes, sha256
`3e547da4f94b14dec27337f8e34f85b2b05b0b660d2b63567f00d491b2646c1e` (base58 code hash
`5CK15Yk69owJDfLPPGa66jp6PYGcuyLhkBhhPazsSKWV`). Three builds from a clean target directory, two
in place and one from a copy of the source in another directory, gave the same bytes.

Honest limits: those three builds were on one machine (macOS, arm64). The same bytes from another
operating system or CPU are expected, since nothing host-specific goes into the wasm, but that has
not been checked. Cargo also reads a `config.toml` from the home directory; extra `rustflags` there
would change the output. The wasm has been executed under Node's WebAssembly engine with stand-in
host functions, **not on a NEAR node or sandbox**: that a node accepts it at deployment, and what a
call costs in gas, are not proven here.

## Test

```sh
node --test test/near/
```

No Rust is needed to test. `test/near/verify-wasm.test.mjs` loads the committed
`contracts/receipts.wasm` and runs it with stand-in host functions (a register, an input, a deposit,
a log list):

- 32 bytes → exactly one log line with the right hex; nothing returned;
- 31, 33, 0 or 64 bytes, hex text, JSON → the call traps, no log, the input is never copied;
- any deposit → the call traps, no log;
- the module imports only the six host functions above (no `storage_*`, no `promise_*`) and exports
  only `record_receipt` and its memory;
- every instruction is WebAssembly 1.0; there is no start function, no table and no custom section.

## Verify the checksum

```sh
cd contracts && shasum -a 256 -c SHA256SUMS      # receipts.wasm: OK
node scripts/check-wasm.mjs                       # from the repository root; exits non-zero on mismatch
```

## Verify a record without a key

```sh
node scripts/verify-receipt.mjs --network mainnet --contract <contract account> \
  --signer <expected recorder account> --tx <transaction hash> --hash <64 hex>

node scripts/verify-receipt.mjs --onchain data/runs/<id>/onchain.json --signer <expected recorder account>
```

Read-only: it needs no key and no account. It asks a public RPC node for the transaction and checks,
one numbered line each:

1. the node serves the chosen network;
2. the transaction exists and is final;
3. its signer is the expected recorder;
4. its receiver is the contract;
5. it is exactly one FunctionCall `record_receipt`;
6. the args are exactly the 32 bytes of the hash;
7. the deposit is 0;
8. the call succeeded on the contract;
9. its log is exactly the one event line for that hash;
10. the code on the contract account is the committed `receipts.wasm`.

Exit 0 means all ten passed. Exit 1 means one failed. Exit 3 is a printed `[skip]` (the node did not
answer, or the transaction is not final yet); a skip is not a pass. With `--onchain` alone the
signer is read from the file, so pass `--signer` to pin the account you expect. The answers are the
RPC node's; the script does not check light-client proofs.

From code: `import { verifyOnChain } from './scripts/verify-receipt.mjs'` →
`{ ok, skipped?, checks: [{ name, ok, skipped?, detail }], why }`.

## Recording a receipt (a human, with a restricted key)

`scripts/record-receipt.mjs` sends exactly one transaction: `record_receipt` with the 32 raw bytes
of the hash as args and deposit 0. It refuses to run with a FullAccess key: the key must be a
function-call access key limited to this contract and to the method `record_receipt`, which it reads
from the chain before signing anything. It refuses mainnet unless
`--i-am-a-human-and-approve-mainnet` is passed, refuses a node that serves another chain, and
refuses a key file that is not mode 600 or belongs to another account. `--dry-run` prints the
unsigned transaction and its hash without signing or sending.

On success it prints the transaction hash. It writes no file unless `--out <file>` is given; then
it writes `{ network, contract, signer, tx_hash, receipt_sha256, block_hash, recorded_at }`, the
file the app reads as `data/runs/<id>/onchain.json` and the verify script reads with `--onchain`.
Run it with `--help` for the near-cli lines that create such a key.
