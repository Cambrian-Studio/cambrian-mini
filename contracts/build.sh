#!/bin/sh
# Builds contracts/receipts.wasm from contracts/receipts/ and writes contracts/SHA256SUMS.
# Needs rustup and nothing else: no docker, no crates to download (the crate has no dependencies).
#
# What decides the bytes:
#   - the compiler:  receipts/rust-toolchain.toml  (an exact stable version + wasm32-unknown-unknown)
#   - the flags:     receipts/.cargo/config.toml   (target-cpu=mvp, 16 kB stack)
#   - the profile:   receipts/Cargo.toml           (opt-level "z", lto, panic=abort, strip, 1 codegen unit)
# Every build starts from a clean target directory. This script deploys nothing.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

# Homebrew installs rustup keg-only (it is not on PATH next to Homebrew's own rust).
if ! command -v rustup >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  PATH="$(brew --prefix rustup 2>/dev/null)/bin:$PATH"
fi
command -v rustup >/dev/null 2>&1 || { echo "build.sh: rustup is not on PATH (https://rustup.rs)" >&2; exit 1; }

# Flags from the environment would change the output; only the committed files may decide it.
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET CARGO_TARGET_DIR RUSTC_WRAPPER

cd "$here/receipts"
toolchain=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
[ -n "$toolchain" ] || { echo "build.sh: no channel in rust-toolchain.toml" >&2; exit 1; }

rustup toolchain install "$toolchain" --profile minimal --target wasm32-unknown-unknown --no-self-update >/dev/null 2>&1 ||
  rustup toolchain install "$toolchain" --profile minimal --target wasm32-unknown-unknown
# Call the pinned toolchain's own cargo and rustc by path. Another rustc earlier on PATH (a
# system or Homebrew one) would otherwise be picked up by cargo and has no wasm32 target.
bin="$(rustup run "$toolchain" rustc --print sysroot)/bin"
"$bin/rustc" --version
RUSTC="$bin/rustc" "$bin/cargo" clean
RUSTC="$bin/rustc" "$bin/cargo" build --release --locked

cp target/wasm32-unknown-unknown/release/receipts.wasm "$here/receipts.wasm"
cd "$here"
chmod 644 receipts.wasm
# shasum on macOS, sha256sum on most Linux images
(command -v shasum >/dev/null 2>&1 && shasum -a 256 receipts.wasm || sha256sum receipts.wasm) > SHA256SUMS
wc -c receipts.wasm
cat SHA256SUMS
