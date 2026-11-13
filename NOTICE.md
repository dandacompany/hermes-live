# Third-party acknowledgments

Codex subscription protocol and integration approach adapted from Synero/hermes-live-voice v0.2.6, https://github.com/Synero/hermes-live-voice. The session broker and shared provider integration are implemented for Hermes Live.

MIT License

Copyright (c) 2026 Synero

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Local wake recognition

The packaged whisper.cpp v1.9.5 engine is MIT licensed (Copyright Georgi Gerganov and contributors). Its license is included in `dashboard/resources/whisper/darwin-arm64/LICENSE`. Source: https://github.com/ggml-org/whisper.cpp/tree/v1.9.5 . The authenticated loopback patch and build recipe are included in `scripts/build-whisper.mjs`. Whisper model weights are downloaded separately, verified, and shared across local bots.
