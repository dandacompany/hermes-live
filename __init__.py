"""Hermes Live unified plugin lifecycle."""
import logging
from pathlib import Path
import sys

logger = logging.getLogger(__name__)


def _run(step, name):
    # Each teardown step is isolated so one failure never leaves Codex sessions open.
    try:
        step()
    except Exception:
        logger.exception('Hermes Live unload step failed: %s', name)


def register(ctx):
    def close_calls():
        wake = sys.modules.get("_hermes_live_wake_v1")
        if wake:
            _run(wake.close, 'wake')
        api_path = Path(__file__).resolve().parent / 'dashboard' / 'plugin_api.py'
        for module in list(sys.modules.values()):
            source = getattr(module, '__file__', None)
            if source and Path(source).resolve() == api_path:
                broker = getattr(module, 'codex', None)
                if broker:
                    _run(broker.login_flow.cancel, 'codex login')
                    _run(broker.sessions.close, 'codex sessions')
    ctx.on_unload(close_calls)
