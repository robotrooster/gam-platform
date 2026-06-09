#!/usr/bin/env bash
#
# Start the self-hosted embeddings server for the agent engine.
#
# Serves bge-large-en-v1.5 (1024-dim) over an OpenAI-compatible
# /v1/embeddings endpoint via llama.cpp. No third-party AI API, no
# per-token cost — embeddings stay on GAM hardware. Pairs with the
# chat model (Hermes) on :8080; this runs on :8081.
#
# One-time setup:
#   brew install llama.cpp
#   mkdir -p ~/models/gam-embeddings
#   curl -L -o ~/models/gam-embeddings/bge-large-en-v1.5-f16.gguf \
#     https://huggingface.co/CompendiumLabs/bge-large-en-v1.5-gguf/resolve/main/bge-large-en-v1.5-f16.gguf
#
# Usage:
#   ./scripts/start-embeddings.sh            # foreground
#   ./scripts/start-embeddings.sh &          # background
#
# Matches EMBEDDINGS_ENDPOINT / EMBEDDINGS_MODEL in .env.

set -euo pipefail

MODEL="${EMBEDDINGS_MODEL_PATH:-$HOME/models/gam-embeddings/bge-large-en-v1.5-f16.gguf}"
PORT="${EMBEDDINGS_PORT:-8081}"

if ! command -v llama-server >/dev/null 2>&1; then
  echo "llama-server not found. Install with: brew install llama.cpp" >&2
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "Model file not found at: $MODEL" >&2
  echo "See the one-time setup block at the top of this script." >&2
  exit 1
fi

echo "Serving $(basename "$MODEL") on http://127.0.0.1:$PORT/v1 (embeddings, CLS pooling)"
exec llama-server \
  -m "$MODEL" \
  --embeddings --pooling cls \
  --host 127.0.0.1 --port "$PORT" \
  -c 512 -b 512
