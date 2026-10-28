#!/usr/bin/env bash
# Step verify-staging (no-command-eval: one script, no arguments).
exec "$(dirname "$0")/verify-env.sh" staging
