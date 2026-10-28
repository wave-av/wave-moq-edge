#!/usr/bin/env bash
# Step verify-production (no-command-eval: one script, no arguments).
exec "$(dirname "$0")/verify-env.sh" production
