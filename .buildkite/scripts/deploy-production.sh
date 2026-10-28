#!/usr/bin/env bash
# Step deploy-production (no-command-eval: one script, no arguments).
exec "$(dirname "$0")/deploy-env.sh" production
