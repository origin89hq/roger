# Package scripts own the checks; keep pnpm check independent from just check.
default:
    @just --list

skills-sync:
    python3 .origin89/sync-engineering.py

fmt:
    pnpm run format

fmt-check:
    pnpm run format:check

lint:
    pnpm run lint

typecheck:
    pnpm run typecheck

test:
    pnpm run test

build:
    pnpm run build

check:
    pnpm check
