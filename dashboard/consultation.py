"""Versioned voice-only integration for trusted, co-installed consultation plugins.

Each consumer gets an isolated session registry. Visitor input must never select
persona, backend path, tools or account; the consultation provider owns those.
"""
from pathlib import Path
import importlib.util
import sys

API_VERSION = 1
_spec = importlib.util.spec_from_file_location(__name__ + '_broker', Path(__file__).with_name('codex_broker.py'))
_broker = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _broker
_spec.loader.exec_module(_broker)

class ConsultationVoice:
    def __init__(self):
        self.sessions = _broker.Sessions()

    def readiness(self):
        return _broker.readiness()

def create_voice():
    return ConsultationVoice()
