# Codex call contract

Contract version: 1

This is the backend contract that Hermes Desktop's bundled client uses for Codex subscription voice calls (`src/codex.ts`). A client other than Hermes Desktop can use it to place the same calls and to detect incompatible changes.

- **Version marker.** `CODEX_CALL_CONTRACT_VERSION` in `dashboard/plugin_api.py` holds the number above. It is not exposed over HTTP; compare the number in this file for the plugin version you run. It changes when a documented field, status code, error code or timing value changes incompatibly. New optional response fields and new error codes can appear without a change, so treat an unknown `code` as a generic failure.
- **Not the consultation API.** `API_VERSION` in `dashboard/consultation.py` versions the in-process Python interface for co-installed consultation plugins. It is separate from this HTTP contract.
- **Scope.** Only what is listed here. Everything else the backend serves (wake, setup, handoff, diagnostics, `/codex/prewarm`) is outside this contract and may change without notice.

## Transport

The routes belong to the plugin's backend API. Hermes Desktop reaches them as `/api/plugins/hermes-live/<route>` on the selected Hermes backend and profile. Authentication is whatever that backend requires for plugin routes; this document does not cover it.

Requests and responses are JSON. Request bodies reject unknown or missing fields with FastAPI's validation response (`422`). Other error responses carry a `detail` string meant for display (mostly Korean) or for Desktop's own matching; do not parse it. Use the status code and, for `/codex/session`, `code`.

## `POST /readiness`

Checks whether Codex calls can start. When the CLI is installed, each request starts a short-lived Codex app-server process to read the account, so it can take several seconds (Desktop allows 30 s).

Request: `{"provider": "codex"}`

`200` response:

```json
{
  "provider": {
    "id": "codex",
    "name": "Codex 구독 · GPT Live",
    "models": [{"id": "gpt-live-1-codex", "name": "GPT Live 1 (Codex 구독)"}],
    "voices": ["cove", "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol"],
    "sampleRate": 48000,
    "available": true,
    "reason": null,
    "authState": "signed_in",
    "plan": "pro"
  },
  "backend": "<backend host name>"
}
```

| `authState` | `available` | `reason` |
|---|---|---|
| `signed_in` | `true` | `null`; `plan` is the account's plan type |
| `cli_missing` | `false` | `HL_ERROR:errCodexMissing` |
| `signed_out` | `false` | `HL_ERROR:errCodexSignedOut` |
| `api_key_login` | `false` | `HL_ERROR:errCodexApiLogin` (only a ChatGPT subscription login can call) |
| `check_failed` | `false` | `HL_ERROR:errCodexCheck` |

`plan` is present only for `signed_in`. An unknown `provider` answers `400` with `detail` `HL_ERROR:errRequest`. The response is sent with `Cache-Control: no-store`.

## `POST /codex/session`

Starts a call and returns the WebRTC answer. The client creates the peer connection, adds its microphone track, creates a data channel labelled `oai-events`, and sends its offer here. Desktop allows 90 s for this request.

Request:

| Field | Type | Rule |
|---|---|---|
| `callId` | string | UUID chosen by the client; identifies the call in every later request |
| `model` | string | a model `id` from `/readiness` (currently `gpt-live-1-codex`) |
| `voice` | string | one of the `voices` from `/readiness` |
| `offer` | string | SDP offer, 16–100000 characters, starting with `v=0` |

`200` response, sent with `Cache-Control: no-store`:

```json
{"answer": "v=0...", "callId": "<the same callId>", "engine": "codex", "handoff": "client"}
```

Desktop treats a response whose `callId` differs, whose `handoff` is not `client`, or whose `answer` is empty as a protocol error. `handoff: "client"` means delegated work arrives on the data channel for the client to run (see below).

### Error codes

Failures answer `{"detail": "<Korean text>", "code": "<code>"}` with `Cache-Control: no-store`. The `detail` texts are the ones earlier versions returned; `code` was added in 0.12.1.

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | Unknown model or voice, or the offer does not start with `v=0` |
| `call_unavailable` | 400 | The `callId` is already in use, was stopped less than 120 s ago, or the backend is shutting down |
| `call_limit` | 400 | Two calls are already in progress |
| `call_cancelled` | 400 | The call was stopped while it was being set up |
| `cli_missing` | 400 | The Codex CLI is not installed on the backend |
| `sign_in_required` | 400 | Codex is signed out or signed in with an API key instead of a ChatGPT subscription |
| `provider_refused` | 400 | The Codex app-server returned an error for a request |
| `provider_timeout` | 400 | The Codex app-server did not answer a request in time |
| `provider_disconnected` | 400 | The Codex app-server process exited or could not be reached |
| `realtime_refused` | 400 | Codex refused the realtime voice connection |
| `realtime_timeout` | 400 | Codex did not return a WebRTC answer within 40 s |
| `session_create_failed` | 400 | Codex did not create a voice thread |
| `session_failed` | 502 | Any other failure |

`invalid_request`, `call_unavailable` and `call_limit` are refused before the call is registered. For every other code the call's Codex process is closed and the `callId` is remembered for 120 s, as after `/codex/stop`.

## `POST /codex/heartbeat`

Request: `{"callId": "<uuid>"}`. `200` response: `{"ok": true}`.

Each heartbeat extends the call to 45 s from now. Desktop sends one every 10 s with an 8 s timeout and ends the call when a heartbeat fails. An unknown call, or one whose Codex process has exited, answers `410` (no `code`).

## `POST /codex/stop`

Request: `{"callId": "<uuid>"}`. Always `200` with `{"ok": true}`, including for unknown or already stopped calls, so it is safe to repeat.

It closes the call's Codex process, stops the in-call wake confirmation owned by that call, and remembers the `callId` for 120 s so a late `/codex/session` with it is refused (`call_unavailable`). Desktop sends it whenever it closes a call, including after a failed start.

## `GET /codex/usage`

Subscription usage of the same Codex account that places calls. Each request starts a short-lived Codex app-server process (Desktop allows 40 s). Sent with `Cache-Control: no-store`.

`200` response:

```json
{
  "plan": "pro",
  "windows": [{"name": "codex", "usedPercent": 12.5, "windowMinutes": 300, "resetsAt": null}],
  "checkedAt": 1763190000
}
```

`usedPercent` is clamped to 0–100. `windowMinutes` and `resetsAt` are passed through from Codex unchanged, in Codex's units, and can be `null`. `checkedAt` is Unix seconds. Any failure, including signed out, answers `503`; provider error text is never relayed.

## Timing and limits

| What | Value |
|---|---|
| Call being set up | stopped once 100 s have passed since `/codex/session` started and it is not ready |
| Ready call without heartbeat | stopped once 45 s have passed since the last heartbeat (or since it became ready) |
| Expiry check | every 10 s and on each start, heartbeat or prewarm, so a stop can lag an expiry by up to about 10 s |
| Desktop heartbeat | every 10 s, 8 s timeout |
| Stopped `callId` memory | 120 s |
| Concurrent calls | two calls at a time per loaded copy of the backend module (`Sessions` in `dashboard/codex_broker.py`); how many copies a host loads is up to the host |
| App-server request timeouts | 15 s to initialize, 10 s to read the account, 25 s for other requests |
| WebRTC answer from Codex | 40 s |

A heartbeat during setup also sets the expiry to 45 s from now.

## Data channel

These are the messages Hermes Desktop **sends and handles** on the `oai-events` channel. It is the set Desktop implements, not a complete list of what Codex may send; Desktop ignores every other message type. All messages are JSON text.

Sent by Desktop:

| Message | When |
|---|---|
| `session.context.append` with `content: [{type: "input_text", text}]` | once when the peer connection is connected and the channel is open (setup context), and once more with a greeting instruction when the call was started by a wake phrase |
| `delegation.context.append` with `delegation_item_id` and `content: [{type: "input_text", text}]` | to return the result of a delegation |

Handled by Desktop:

| Message | Fields Desktop reads | Desktop's action |
|---|---|---|
| `input_transcript.added`, `output_transcript.added` | `item.text` | shows the user's or assistant's live transcript |
| `turn.done` | `turn.role`, `turn.transcript`, `turn.id` | with `role: "user"` and a string `transcript`: ends the user's utterance with that final text (used for bot-switch and goodbye commands; a repeated `turn.id` is ignored); otherwise: marks the end of a turn |
| `delegation.created` | `item.id`, `item.target` (must be `client`), `item.content[]` entries of type `input_text` | sends the joined text to the connected Hermes chat as a request and later answers with `delegation.context.append`; ignored without a string `id` or with another `target` |
| `delegation.cancelled` | `delegation_item_id` | cancels that running request |
| `session.usage.updated` | `usage.audio_duration_ms` | records audio usage |
| `error` | – | ends the call (`errRejected`) |
| `session.closed` | – | ends the call (`errConnection`) |

A message that is not valid JSON ends the call as a protocol error. Desktop also ends the call when the channel closes, when the peer connection fails or stays disconnected for more than 10 s, or when the connection is not up within 90 s.
