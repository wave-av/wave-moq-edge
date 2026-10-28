#!/bin/sh
# FPC agents run --no-command-eval: the pipeline-upload step must be a repo  # guard:allow plain-English word, not a repo reference
# script, never an inline command. Re-uploads the real pipeline.
set -eu
exec buildkite-agent pipeline upload --no-interpolation .buildkite/pipeline.yml
