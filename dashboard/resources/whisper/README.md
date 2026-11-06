# Local wake engine

whisper.cpp v1.9.5, MIT. The darwin-arm64 engine is statically linked to whisper/ggml and uses only macOS system frameworks (Metal/Accelerate); no Homebrew or Node runtime is required.

The build recipe is `scripts/build-whisper.mjs`. The source archive SHA256 and executable checksum are pinned in the packaged manifest. The inference server requires a random per-process bearer token, binds to loopback, accepts only health/inference, and rejects other routes. The token environment variable retains the original patch name `BOTIN_WHISPER_TOKEN`; no BotIn installation or code import is required. Never pass this internal token to the renderer or logs.

The packaged executable was built for Apple Silicon and signed by Dante Labs. Rebuild and sign before changing the pinned engine hash in `dashboard/wake_assets.py`. Other architectures are not shipped or advertised as supported for wake recognition.

The included `darwin-arm64/LICENSE` applies to whisper.cpp. Model files are fetched separately from the fixed revision of `ggerganov/whisper.cpp` on Hugging Face; every file is checked against its pinned byte size and SHA256 before use. Model source/licensing: https://huggingface.co/ggerganov/whisper.cpp .
