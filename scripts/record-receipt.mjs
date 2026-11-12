#!/usr/bin/env node
// Logs one receipt hash through the log-only receipts contract: one FunctionCall record_receipt
// whose args are the 32 raw bytes of the hash, deposit 0. Meant to be run by a human who holds a
// function-call-only key; see `--help` and near/record.mjs for every refusal it applies.
// It writes no file unless --out <file> is given. To check a record without a key, use
// scripts/verify-receipt.mjs.
import { runCli } from '../near/record.mjs';

process.exitCode = await runCli(process.argv.slice(2));
