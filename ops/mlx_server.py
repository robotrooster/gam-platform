"""
GAM's launcher for mlx_lm.server (com.gam.model, :8080).

S650: the model server kept dying with

    [METAL] Command buffer execution failed: Insufficient Memory

because nothing capped the KV caches it keeps between requests by SIZE.

  * --prompt-cache-size caps the COUNT of cached conversations (6). A landlord
    turn is ~25k tokens and this model's KV cache is 256 KB per token
    (64 layers x 8 kv heads x 128 dims x K+V x fp16), so one conversation is
    ~6.5 GB and six of them is ~39 GB on top of the 28 GB model.
  * --prompt-cache-bytes exists, but mlx_lm 0.31 only applies it on the
    BATCHED path. Tool-calling requests take _serve_single, which never trims.
    The LRU itself knows how to enforce a byte cap (LRUPromptCache.max_bytes);
    the server just never passes one in.
  * MLX also keeps freed GPU buffers in its own cache for reuse, and by default
    that cache may grow to the whole memory limit.

So this wrapper hands the LRU its byte cap and bounds MLX's buffer cache, then
runs the stock server unchanged. Eviction only ever costs a re-prefill, which
is slower and never wrong; running out of memory kills every conversation.

Env (all optional):
  GAM_MLX_PROMPT_CACHE_GB  byte cap across all cached conversations (default 20)
  GAM_MLX_BUFFER_CACHE_GB  MLX freed-buffer cache cap (default 4)
"""
import os
import sys

import mlx.core as mx
from mlx_lm.models import cache as mlx_cache
import mlx_lm.server as server

GB = 1 << 30
PROMPT_CACHE_BYTES = int(float(os.environ.get("GAM_MLX_PROMPT_CACHE_GB", "20")) * GB)
BUFFER_CACHE_BYTES = int(float(os.environ.get("GAM_MLX_BUFFER_CACHE_GB", "4")) * GB)

_original_init = mlx_cache.LRUPromptCache.__init__


def _capped_init(self, max_size: int = 10, max_bytes: int = 1 << 63):
    _original_init(self, max_size=max_size, max_bytes=min(max_bytes, PROMPT_CACHE_BYTES))


mlx_cache.LRUPromptCache.__init__ = _capped_init
mx.set_cache_limit(BUFFER_CACHE_BYTES)

print(
    f"[gam] prompt cache capped at {PROMPT_CACHE_BYTES / GB:.0f} GB, "
    f"buffer cache at {BUFFER_CACHE_BYTES / GB:.0f} GB",
    file=sys.stderr, flush=True,
)

if __name__ == "__main__":
    sys.argv[0] = "mlx_lm.server"
    sys.exit(server.main())
