# Package scripts own the Node checks; keep pnpm check independent from just check.
default:
    @just --list

skills-sync:
    python3 .origin89/sync-engineering.py

fmt:
    pnpm run format
    cargo fmt --all

fmt-check:
    pnpm run format:check
    cargo fmt --all --check

lint:
    pnpm run lint
    cargo clippy --locked --workspace --all-targets -- -D warnings

typecheck:
    pnpm run typecheck

test:
    cargo test --locked --workspace
    pnpm run test

build:
    cargo build --locked --workspace
    pnpm run build

# Regenerate apps/worker/src/protocol.gen.ts from crates/roger-protocol.
protocol:
    ROGER_WRITE_BINDINGS=1 cargo test --locked -p roger-protocol typescript_bindings_are_current

# Rust first: its tests fail if the generated TypeScript is stale.
check: rust-check
    pnpm check

rust-check:
    cargo fmt --all --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo test --locked --workspace
    cargo build --locked --workspace

# Run the Worker locally against a local D1 and apps/worker/.dev.vars.
dev:
    pnpm --filter roger-worker exec wrangler d1 migrations apply roger --local
    pnpm --filter roger-worker dev
