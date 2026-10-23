#!/bin/sh
# Builds js/dist/rill_highlight.wasm (raw C-ABI exports, no wasm-bindgen). Needs
# `rustup target add wasm32-unknown-unknown` and `npm install` in js/ (binaryen).
set -eu
cd "$(dirname "$0")/../.."
export RUSTFLAGS="--remap-path-prefix=$HOME=~ --remap-path-prefix=$PWD=."
cargo build --release --lib --features wasm-exports --target wasm32-unknown-unknown \
  --config profile.release.lto=true --config profile.release.codegen-units=1 \
  --config profile.release.debug=false --config profile.release.strip=true --config profile.release.panic=\"abort\"
mkdir -p js/dist
js/node_modules/.bin/wasm-opt -O3 target/wasm32-unknown-unknown/release/rill_highlight.wasm -o js/dist/rill_highlight.wasm \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-multivalue --enable-reference-types
ls -l js/dist/rill_highlight.wasm
