#!/bin/sh
# agent-stub.sh — the stand-in agent for offline runs. It runs behind the wall, in the worktree, exactly
# where the real agent would, and copies a known-good solution (reference/) instead of asking a model.
# Two markers in a ticket's task make it misbehave on purpose, so tests can watch the line react:
#   STUB:late-readme   leave the README out on the first attempt (the second attempt then goes green)
#   STUB:escape        also try to write beside the worktree (the wall must refuse it)
# Usage (inside the worktree): agent-stub.sh <attempt-number>
# The product's own test is stored as page-test.fixture so the test runner of THIS repository does not pick it up.
D=$(dirname "$0"); cp -R "$D/reference/." . && mv page-test.fixture page.test.mjs
if grep -q 'STUB:late-readme' .oc/TICKET.md && [ "$1" = 1 ]; then rm -f README.md; fi
if grep -q 'STUB:escape' .oc/TICKET.md; then echo x > ../escaped 2>/dev/null || echo "escape refused"; fi
echo "stand-in agent: attempt $1 done"
