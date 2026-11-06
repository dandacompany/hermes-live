"""Best-effort preparation of enabled LOCAL bots, without changing Desktop's active profile."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import time
from urllib.parse import urlparse


def warm_profile(home):
    import httpx
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_cli.gateway_client import _session_ticket
    endpoint = discover_gateway_endpoint(Path(home)).endpoint
    # Preparation never launches gateways or reaches remote connections.
    if not endpoint or urlparse(endpoint.api_origin).hostname not in ('localhost','127.0.0.1','::1'):
        return
    ticket = _session_ticket(Path(home), endpoint, purpose='native-http')
    with httpx.Client(trust_env=False, timeout=4) as client:
        client.post(endpoint.api_origin+'/api/plugins/hermes-live/codex/prewarm',
                    headers={'X-Hermes-Gateway-Ticket':ticket}).raise_for_status()


class WarmTargets:
    def __init__(self, warm=warm_profile, clock=time.monotonic):
        self.warm,self.clock=warm,clock
        self.lock=threading.Lock();self.running=False;self.due=0

    def refresh(self, homes):
        homes=tuple(dict.fromkeys(str(p) for p in homes))
        with self.lock:
            if self.running or self.clock()<self.due:return
            self.running=True;self.due=self.clock()+8
        def run():
            try:
                with ThreadPoolExecutor(max_workers=4,thread_name_prefix='live-warm-target') as pool:
                    futures=[pool.submit(self.warm,home) for home in homes]
                    for future in futures:
                        try:future.result()
                        except Exception:pass  # Missing/old/offline backend uses the normal cold path.
            finally:
                with self.lock:self.running=False
        threading.Thread(target=run,name='live-warm-bots',daemon=True).start()


targets=WarmTargets()
