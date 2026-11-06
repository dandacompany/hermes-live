"""Hermes Live unified plugin lifecycle."""
from pathlib import Path
import sys


def register(ctx):
    def close_calls():
        wake = sys.modules.get("_hermes_live_wake_v1")
        if wake:
            wake.close()
        api_path = Path(__file__).resolve().parent / 'dashboard' / 'plugin_api.py'
        for module in list(sys.modules.values()):
            source = getattr(module, '__file__', None)
            if source and Path(source).resolve() == api_path:
                broker = getattr(module, 'codex', None)
                if broker:
                    broker.login_flow.cancel()
                    broker.sessions.close()
    ctx.on_unload(close_calls)
