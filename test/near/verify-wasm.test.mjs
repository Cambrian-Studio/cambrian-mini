// Runs the committed contracts/receipts.wasm itself, with stand-in NEAR host functions, and reads
// its structure byte by byte. This is the artifact that would be deployed, not a model of it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { receiptEventLine } from '../../near/rpc.mjs';

const WASM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'receipts.wasm'));
const MODULE = new WebAssembly.Module(WASM);

// The only host functions the contract may import. Anything else (storage_*, promise_*, ...) fails.
const EXPECTED_IMPORTS = ['attached_deposit', 'input', 'log_utf8', 'panic_utf8', 'read_register', 'register_len'];

class HostPanic extends Error {}

/**
 * One call of record_receipt in a fresh instance. The host side is a stand-in for the NEAR VM:
 * registers, the call input, the attached deposit, a log list. Returns what the host saw.
 */
function call({ input, deposit = 0n, panicReturns = false }) {
  const seen = { logs: [], panic: null, trapped: null, hostCalls: [] };
  const registers = new Map();
  let memory;
  const bytes = (ptr, len) => new Uint8Array(memory.buffer, Number(ptr), Number(len));
  const text = (ptr, len) => new TextDecoder('utf-8', { fatal: true }).decode(bytes(ptr, len));
  const env = {
    input: (registerId) => registers.set(registerId, Uint8Array.from(input)),
    register_len: (registerId) => (registers.has(registerId) ? BigInt(registers.get(registerId).length) : 0xffff_ffff_ffff_ffffn),
    read_register: (registerId, ptr) => bytes(ptr, registers.get(registerId).length).set(registers.get(registerId)),
    attached_deposit: (ptr) => {
      for (let i = 0; i < 16; i++) bytes(ptr, 16)[i] = Number((deposit >> BigInt(8 * i)) & 0xffn);
    },
    log_utf8: (len, ptr) => seen.logs.push(text(ptr, len)),
    panic_utf8: (len, ptr) => {
      seen.panic = text(ptr, len);
      // The real host never returns from a panic. panicReturns:true checks the wasm traps anyway.
      if (!panicReturns) throw new HostPanic(seen.panic);
    },
  };
  for (const name of Object.keys(env)) {
    const real = env[name];
    env[name] = (...args) => {
      seen.hostCalls.push(name);
      return real(...args);
    };
  }
  const instance = new WebAssembly.Instance(MODULE, { env });
  memory = instance.exports.memory;
  try {
    seen.returned = instance.exports.record_receipt();
  } catch (err) {
    if (!(err instanceof HostPanic) && !(err instanceof WebAssembly.RuntimeError)) throw err;
    seen.trapped = err;
  }
  return seen;
}

const sha = (textIn) => createHash('sha256').update(textIn).digest();

test('32 bytes: exactly one log line, the receipt event with the hash in lowercase hex; nothing returned', () => {
  const inputs = [
    sha('a receipt'),
    Buffer.alloc(32, 0x00),
    Buffer.alloc(32, 0xff),
    Buffer.from(Array.from({ length: 32 }, (_, i) => i * 8 + 5)), // covers every high and low nibble
    Buffer.from('0123456789abcdeffedcba98765432100f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex'),
  ];
  for (const input of inputs) {
    const hex = input.toString('hex');
    const seen = call({ input });
    assert.equal(seen.trapped, null, hex);
    assert.equal(seen.panic, null);
    assert.equal(seen.returned, undefined, 'the function returns nothing');
    const expected = `EVENT_JSON:{"standard":"cambrian-receipt","version":"1.0.0","event":"record_receipt","data":[{"sha256":"${hex}"}]}`;
    assert.deepEqual(seen.logs, [expected]);
    assert.equal(seen.logs[0], receiptEventLine(hex), 'the verifier expects this exact line');
    const event = JSON.parse(seen.logs[0].slice('EVENT_JSON:'.length));
    assert.deepEqual(event, { standard: 'cambrian-receipt', version: '1.0.0', event: 'record_receipt', data: [{ sha256: hex }] });
    assert.deepEqual(seen.hostCalls, ['attached_deposit', 'input', 'register_len', 'read_register', 'log_utf8']);
  }
});

test('two different hashes give two different lines (the hash is not a constant)', () => {
  const a = call({ input: sha('one') }).logs[0];
  const b = call({ input: sha('two') }).logs[0];
  assert.notEqual(a, b);
  assert.ok(a.includes(sha('one').toString('hex')));
});

test('31, 33, 0, 64 bytes and the hex text of a hash: the call traps and logs nothing', () => {
  const hash = sha('a receipt');
  const wrong = [hash.subarray(0, 31), Buffer.concat([hash, Buffer.from([0])]), Buffer.alloc(0), Buffer.concat([hash, hash])];
  wrong.push(Buffer.from(hash.toString('hex'), 'utf8'), Buffer.from(JSON.stringify({ hash: hash.toString('hex') })));
  for (const input of wrong) {
    const seen = call({ input });
    assert.ok(seen.trapped instanceof HostPanic, `${input.length} bytes must panic`);
    assert.equal(seen.panic, 'record_receipt: input must be exactly 32 bytes (the receipt sha256)');
    assert.deepEqual(seen.logs, []);
    assert.equal(seen.hostCalls.includes('read_register'), false, 'a wrong-length input is never copied into memory');
    assert.equal(seen.hostCalls.includes('log_utf8'), false);
  }
});

test('any deposit: the call traps and logs nothing, even with a valid 32-byte input', () => {
  for (const deposit of [1n, 10n ** 24n, 1n << 64n, (1n << 128n) - 1n]) {
    const seen = call({ input: sha('a receipt'), deposit });
    assert.ok(seen.trapped instanceof HostPanic, `deposit ${deposit} must panic`);
    assert.equal(seen.panic, 'record_receipt: no deposit');
    assert.deepEqual(seen.logs, []);
    assert.deepEqual(seen.hostCalls, ['attached_deposit', 'panic_utf8']);
  }
  // The other direction: the same input with no deposit logs.
  assert.equal(call({ input: sha('a receipt'), deposit: 0n }).logs.length, 1);
});

test('if the host panic ever returned, the wasm still stops: it traps and logs nothing', () => {
  for (const args of [{ input: Buffer.alloc(31) }, { input: sha('x'), deposit: 5n }]) {
    const seen = call({ ...args, panicReturns: true });
    assert.ok(seen.trapped instanceof WebAssembly.RuntimeError);
    assert.match(seen.trapped.message, /unreachable/);
    assert.deepEqual(seen.logs, []);
  }
});

test('imports: only the six expected host functions from "env"; no storage or promise function exists in it', () => {
  const imports = WebAssembly.Module.imports(MODULE);
  assert.deepEqual(imports.map((i) => i.name).sort(), EXPECTED_IMPORTS);
  for (const i of imports) {
    assert.equal(i.module, 'env');
    assert.equal(i.kind, 'function');
  }
  const names = imports.map((i) => i.name).join(' ');
  assert.doesNotMatch(names, /storage|promise|value_return|predecessor|signer|transfer|sha256/);
  // The bytes themselves do not even contain the words.
  const raw = WASM.toString('latin1');
  for (const word of ['storage_', 'promise_', 'value_return']) assert.equal(raw.includes(word), false, word);
});

test('exports: record_receipt and the memory, nothing else', () => {
  const exports = WebAssembly.Module.exports(MODULE);
  assert.deepEqual(
    exports.map((e) => `${e.kind} ${e.name}`).sort(),
    ['function record_receipt', 'memory memory'],
  );
});

// ---- structure: WebAssembly 1.0 (MVP) only -----------------------------------------------------
// A NEAR node refuses modules that use newer instruction sets. The reader below walks the module
// and throws on anything that is not in the 1.0 specification.

function reader(buf, start = 0, end = buf.length) {
  let pos = start;
  const r = {
    get pos() { return pos; },
    get done() { return pos >= end; },
    byte() {
      if (pos >= end) throw new Error('read past the end');
      return buf[pos++];
    },
    // unsigned LEB128, also fine for skipping signed ones
    leb() {
      let result = 0n;
      for (let shift = 0n; ; shift += 7n) {
        const b = r.byte();
        result |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) return Number(result & 0xffff_ffff_ffffn);
      }
    },
    skip(n) {
      pos += n;
      if (pos > end) throw new Error('skip past the end');
    },
    sub(n) {
      const s = reader(buf, pos, pos + n);
      r.skip(n);
      return s;
    },
    name() {
      const n = r.leb();
      const s = Buffer.from(buf.subarray(pos, pos + n)).toString('utf8');
      r.skip(n);
      return s;
    },
  };
  return r;
}

const VALUE_TYPES = [0x7f, 0x7e, 0x7d, 0x7c]; // i32 i64 f32 f64

/** Walks one function body; throws on the first instruction that is not WebAssembly 1.0. */
function assertMvpCode(body) {
  for (let groups = body.leb(); groups > 0; groups--) {
    body.leb();
    const type = body.byte();
    if (!VALUE_TYPES.includes(type)) throw new Error(`local of non-MVP type 0x${type.toString(16)}`);
  }
  let count = 0;
  while (!body.done) {
    const op = body.byte();
    count++;
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      const blockType = body.byte();
      // 0x40 = no result, or one value type. A type index here would be the multi-value proposal.
      if (blockType !== 0x40 && !VALUE_TYPES.includes(blockType)) throw new Error(`multi-value block type 0x${blockType.toString(16)}`);
    } else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24) || op === 0x41 || op === 0x42) {
      body.leb();
    } else if (op === 0x0e) {
      for (let n = body.leb() + 1; n > 0; n--) body.leb();
    } else if (op === 0x11) {
      body.leb();
      if (body.byte() !== 0x00) throw new Error('call_indirect on a table other than 0 (reference-types)');
    } else if (op >= 0x28 && op <= 0x3e) {
      body.leb();
      body.leb();
    } else if (op === 0x3f || op === 0x40) {
      if (body.byte() !== 0x00) throw new Error('memory index other than 0 (multi-memory)');
    } else if (op === 0x43) body.skip(4);
    else if (op === 0x44) body.skip(8);
    else if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xbf)) {
      // no immediates
    } else {
      // 0xc0-0xc4 sign-ext, 0xfc bulk-memory and nontrapping-fptoint, 0xd0-0xd2 and 0x25/0x26
      // reference-types, 0xfd simd, 0xfe threads, 0x12/0x13 tail calls, 0x06-0x0a exceptions
      throw new Error(`non-MVP opcode 0x${op.toString(16)} at byte ${body.pos - 1}`);
    }
  }
  return count;
}

/** Splits the module into sections and applies the MVP checks. → what was found. */
function inspect(buf) {
  assert.equal(Buffer.from(buf.subarray(0, 8)).toString('hex'), '0061736d01000000', 'wasm magic and version 1');
  const r = reader(buf, 8);
  const found = { sections: [], custom: [], functions: 0, instructions: 0, memoryPages: null, multiResultTypes: 0 };
  while (!r.done) {
    const id = r.byte();
    const section = r.sub(r.leb());
    found.sections.push(id);
    if (id === 0) found.custom.push(section.name());
    else if (id === 1) {
      for (let n = section.leb(); n > 0; n--) {
        assert.equal(section.byte(), 0x60, 'a function type');
        for (let p = section.leb(); p > 0; p--) assert.ok(VALUE_TYPES.includes(section.byte()), 'MVP parameter type');
        const results = section.leb();
        if (results > 1) found.multiResultTypes++;
        for (let p = results; p > 0; p--) assert.ok(VALUE_TYPES.includes(section.byte()), 'MVP result type');
      }
    } else if (id === 5) {
      assert.equal(section.leb(), 1, 'one memory');
      const flags = section.byte();
      assert.ok(flags === 0 || flags === 1, 'plain memory limits (not shared, not 64-bit)');
      found.memoryPages = section.leb();
    } else if (id === 10) {
      for (let n = section.leb(); n > 0; n--) {
        found.functions++;
        found.instructions += assertMvpCode(section.sub(section.leb()));
      }
    }
  }
  return found;
}

test('structure: every instruction is WebAssembly 1.0; no bulk-memory, sign-ext, multi-value or reference types', () => {
  const found = inspect(WASM);
  // 1 type, 2 import, 3 function, 5 memory, 6 global, 7 export, 10 code, 11 data: all 1.0 sections.
  // Absent on purpose: 8 (start function), 4 and 9 (table and elements), 12 (data count, bulk-memory).
  assert.deepEqual(found.sections, [1, 2, 3, 5, 6, 7, 10, 11]);
  assert.deepEqual(found.custom, [], 'no custom section: no names, no producers, no build paths');
  assert.equal(found.multiResultTypes, 0);
  assert.equal(found.memoryPages, 1, 'one 64 kB page');
  assert.ok(found.functions >= 1 && found.instructions > 50, 'the code section was really walked');
  assert.ok(WASM.length < 4096, `a few hundred bytes to a few kB, got ${WASM.length}`);
});

test('the structure reader itself refuses post-MVP code (it is not a rubber stamp)', () => {
  const body = (...ops) => reader(Uint8Array.from([0x00, ...ops, 0x0b]));
  assert.equal(assertMvpCode(body(0x41, 0x00, 0x1a)), 3); // i32.const 0, drop, end
  assert.throws(() => assertMvpCode(body(0x41, 0x00, 0xc0, 0x1a)), /non-MVP opcode 0xc0/); // i32.extend8_s (sign-ext)
  assert.throws(() => assertMvpCode(body(0xfc, 0x0a, 0x00, 0x00)), /non-MVP opcode 0xfc/); // memory.copy (bulk-memory)
  assert.throws(() => assertMvpCode(body(0xfc, 0x00)), /non-MVP opcode 0xfc/); // i32.trunc_sat_f32_s (nontrapping-fptoint)
  assert.throws(() => assertMvpCode(body(0xd0, 0x70)), /non-MVP opcode 0xd0/); // ref.null (reference-types)
  assert.throws(() => assertMvpCode(body(0x02, 0x00, 0x0b)), /multi-value block type/); // block with a type index
});
