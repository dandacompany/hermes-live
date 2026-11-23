# Changelog

## 0.12.6

- Switchboard local voice links work when Hermes Desktop reports a local connection without an ID. Commands still require local token verification and are rejected when a remote connection is active.
- Switchboard can end the matching remote bot’s active call even if its connection is offline or has been removed. Both Stop and Toggle work in this case. A command for a different bot cannot end the call.
