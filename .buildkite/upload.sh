#!/bin/sh
# FPC agents run --no-command-eval: the pipeline-upload step must be a repo
# script, never an inline command. Re-uploads the real pipeline.
set -eu
exec buildkite-agent pipeline upload .buildkite/pipeline.yml
