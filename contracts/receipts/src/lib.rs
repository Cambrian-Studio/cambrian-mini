//! Log-only receipt contract for NEAR. Raw wasm: no SDK, no allocator, no dependencies.
//!
//! What this contract guarantees:
//!   - it exports exactly one function, `record_receipt`;
//!   - the call input must be exactly 32 raw bytes (the sha256 of a receipt), else it panics;
//!   - the attached deposit must be zero, else it panics;
//!   - on success it emits exactly one log line, the NEP-297 event below, and does nothing else:
//!     it writes no storage, calls no other contract and returns no value.
//!
//! What it does NOT do: it has no owner and no allow-list. Anyone may log any 32 bytes. A record
//! means something only when the transaction that carries it was signed by the expected recorder
//! account; scripts/verify-receipt.mjs checks exactly that.
#![no_std]

// NEAR host functions, imported from the wasm module "env". Signatures as declared in the near-sys
// crate, version 0.4.1 (https://docs.rs/near-sys/0.4.1/src/near_sys/lib.rs.html), the bindings
// near-sdk itself uses for nearcore's host functions:
//   input(register_id: u64)                      copies the call input into a register
//   register_len(register_id: u64) -> u64        length of a register (u64::MAX when unset)
//   read_register(register_id: u64, ptr: u64)    copies a register into guest memory at ptr
//   attached_deposit(balance_ptr: u64)           writes the deposit as a little-endian u128 at ptr
//   log_utf8(len: u64, ptr: u64)                 appends one log line to the execution outcome
//   panic_utf8(len: u64, ptr: u64) -> !          aborts the call with a message
// Only these six are imported. No storage_* and no promise_* function is linked at all.
#[link(wasm_import_module = "env")]
extern "C" {
    fn input(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn attached_deposit(balance_ptr: u64);
    fn log_utf8(len: u64, ptr: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
}

const PREFIX: &[u8] =
    br#"EVENT_JSON:{"standard":"cambrian-receipt","version":"1.0.0","event":"record_receipt","data":[{"sha256":""#;
const SUFFIX: &[u8] = br#""}]}"#;
const HASH_LEN: usize = 32;
const LINE_LEN: usize = PREFIX.len() + 2 * HASH_LEN + SUFFIX.len();

/// The whole log line with 64 zeros where the hex digits go. Built at compile time.
const TEMPLATE: [u8; LINE_LEN] = {
    let mut line = [b'0'; LINE_LEN];
    let mut i = 0;
    while i < PREFIX.len() {
        line[i] = PREFIX[i];
        i += 1;
    }
    let mut j = 0;
    while j < SUFFIX.len() {
        line[PREFIX.len() + 2 * HASH_LEN + j] = SUFFIX[j];
        j += 1;
    }
    line
};

const BAD_INPUT: &[u8] = b"record_receipt: input must be exactly 32 bytes (the receipt sha256)";
const NO_DEPOSIT: &[u8] = b"record_receipt: no deposit";

fn fail(message: &[u8]) -> ! {
    unsafe { panic_utf8(message.len() as u64, message.as_ptr() as u64) }
}

/// One lowercase hex digit for a value 0..=15.
fn hex_digit(nibble: u8) -> u8 {
    if nibble < 10 {
        b'0' + nibble
    } else {
        b'a' + (nibble - 10)
    }
}

/// The only exported function. Input: exactly 32 raw bytes. Effect: one log line. Nothing else.
#[no_mangle]
pub extern "C" fn record_receipt() {
    // Deposit must be zero: this contract never holds anybody's money.
    let mut deposit = [0u8; 16];
    unsafe { attached_deposit(deposit.as_mut_ptr() as u64) };
    if u128::from_le_bytes(deposit) != 0 {
        fail(NO_DEPOSIT);
    }

    // The length is checked before anything is copied, so the 32-byte buffer cannot overflow.
    unsafe { input(0) };
    if unsafe { register_len(0) } != HASH_LEN as u64 {
        fail(BAD_INPUT);
    }
    let mut hash = [0u8; HASH_LEN];
    unsafe { read_register(0, hash.as_mut_ptr() as u64) };

    // The line is built in a fixed buffer on the stack; there is no allocator in this module.
    let mut line = TEMPLATE;
    let digits = &mut line[PREFIX.len()..PREFIX.len() + 2 * HASH_LEN];
    for (pair, byte) in digits.chunks_exact_mut(2).zip(hash.iter()) {
        pair[0] = hex_digit(byte >> 4);
        pair[1] = hex_digit(byte & 0x0f);
    }
    unsafe { log_utf8(line.len() as u64, line.as_ptr() as u64) };
}

// Required by no_std. Nothing above can panic in Rust terms; if it ever did, the call traps.
#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
