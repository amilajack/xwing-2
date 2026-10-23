#!/bin/bash
set -euo pipefail
pnpm run server:build
mkdir -p outputs/deploy
docker buildx build --platform linux/arm64 --file ops/Dockerfile --output type=local,dest=outputs/deploy .
