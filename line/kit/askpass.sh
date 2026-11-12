#!/bin/sh
# askpass.sh — git's credential prompt, answered from ONE file: the token for the remote of this push.
# git calls it with the prompt as $1. The token is read at use and printed to git alone; it is never in
# argv, a URL, a config file or the environment (the environment carries the file's PATH only).
# Used with `-c credential.helper=` so no keychain entry and no other credential can answer in its place.
case "$1" in
  Username*) printf 'x-access-token\n' ;;
  *) [ -n "${LINE_TOKEN_FILE:-}" ] && [ -r "$LINE_TOKEN_FILE" ] || exit 1; /bin/cat "$LINE_TOKEN_FILE" ;;
esac
