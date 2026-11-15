# Local wake engine

whisper.cpp v1.9.5, MIT. The darwin-arm64 engine is statically linked to whisper/ggml and uses only macOS system frameworks (Metal/Accelerate); no Homebrew or Node runtime is required.

The build recipe is `scripts/build-whisper.mjs`, which refuses a source archive whose SHA256 differs from its pinned value. At runtime the engine is used only when its size and SHA256 match `ENGINE_SHA` in `dashboard/wake_assets.py`. `darwin-arm64/manifest.json` records the build (version, checksums, patch, signing identity) for reference; nothing reads it at runtime. The inference server requires a random per-process bearer token, binds to loopback, accepts only health/inference, and rejects other routes. The token environment variable retains the original patch name `BOTIN_WHISPER_TOKEN`; no BotIn installation or code import is required. Never pass this internal token to the renderer or logs.

The packaged executable was built for Apple Silicon and signed with the Developer ID Application certificate “Jiho Kwak (YXPA46F4SJ)”. Rebuild and sign before changing the pinned engine hash in `dashboard/wake_assets.py`. Other architectures are not shipped or advertised as supported for wake recognition.

The included `darwin-arm64/LICENSE` applies to whisper.cpp. Model files are fetched separately from the fixed revision of `ggerganov/whisper.cpp` on Hugging Face; every file is checked against its pinned byte size and SHA256 before use. Model source/licensing: https://huggingface.co/ggerganov/whisper.cpp .
