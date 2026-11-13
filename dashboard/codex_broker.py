"""Codex-owned subscription auth and per-call app-server lifecycle.

Protocol reference: Synero/hermes-live-voice (MIT), local Codex schema 0.163.
No credential file is opened, copied, refreshed or returned by this module.
"""
from __future__ import annotations
import atexit
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

VOICES = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol']
SKIP = 'The client executes every delegated request in Hermes. Reply only "skip". Do not use tools, read files, call MCP, run commands, or perform delegated work.'
PERSONA = ('You are Hermes Live. Speak in the user\'s language, Korean by default. '
           'Delegate only clear action requests, factual research or work requiring tools to the client. '
           'Include the complete request and context in delegation text. '
           'Handle greetings and clarifications yourself. Acknowledge briefly, then wait for the client result. '
           'Never invent tool results. Speak concisely without reading Markdown aloud.')


def binary():
    return shutil.which('codex') or next((str(p) for p in [Path('/opt/homebrew/bin/codex'), Path.home()/'.local/bin/codex', Path('/usr/local/bin/codex')] if p.is_file()), None)


# The vendor CLI gets an allowlisted environment, never a copy of Hermes's process
# environment: bot tokens, provider keys and other secrets Hermes loaded stay behind.
ENV_ALLOW = frozenset({
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
    'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
    'CODEX_CA_CERTIFICATE',
    # Windows process basics.
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
})


def child_env(source=None):
    source = os.environ if source is None else source
    return {key: value for key, value in source.items()
            if key in ENV_ALLOW or key.startswith('LC_')}


class BrokerError(RuntimeError):
    pass


class AppServer:
    def __init__(self):
        self.condition = threading.Condition()
        self.pending = {}
        self.events = []
        self.seq = 0
        self.closed = False
        self.proc = None
        self.workdir = None

    def start(self):
        executable = binary()
        if not executable:
            raise BrokerError('백엔드에 Codex CLI를 설치하고 codex login으로 로그인하세요.')
        with self.condition:
            if self.closed:
                raise BrokerError('취소된 통화입니다.')
            self.workdir = tempfile.TemporaryDirectory(prefix='hermes-live-')
            self.proc = subprocess.Popen(
                [executable, 'app-server', '--listen', 'stdio://', '--enable', 'realtime_conversation',
                 '-c', 'model_provider="openai"', '-c', 'features.shell_tool=false',
                 '-c', 'features.multi_agent=false', '-c', 'features.plugins=false',
                 '-c', 'features.apps=false', '-c', 'features.hooks=false',
                 '-c', 'suppress_unstable_features_warning=true'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, bufsize=1, env=child_env(), cwd=self.workdir.name)
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        self.request('initialize', {'clientInfo': {'name':'hermes-live','version':'0.9.0'},
                                    'capabilities': {'experimentalApi':True}}, 15)
        self.send({'method':'initialized','params':{}})

    def send(self, value):
        with self.condition:
            if self.closed or not self.proc or self.proc.poll() is not None:
                raise BrokerError('Codex 음성 연결이 종료되었습니다.')
            try:
                self.proc.stdin.write(json.dumps(value)+'\n')
                self.proc.stdin.flush()
            except (OSError, ValueError):
                raise BrokerError('Codex 프로세스와 통신하지 못했습니다.') from None

    def _read(self, proc):
        try:
            for line in proc.stdout:
                try:
                    message = json.loads(line)
                except (ValueError, TypeError):
                    continue
                with self.condition:
                    if 'id' in message and 'method' not in message:
                        if message['id'] in self.pending:
                            self.pending[message['id']] = message
                    elif 'id' in message:
                        # Never approve a backing-agent operation. Voice work belongs to Hermes.
                        self.send({'id':message['id'],'error':{'code':-32601,'message':'Voice-only client does not execute server tool requests'}})
                    elif str(message.get('method','')).startswith(('thread/realtime/', 'account/login/')):
                        self.events.append(message)
                        self.events = self.events[-128:]
                    self.condition.notify_all()
        except (OSError, ValueError, BrokerError):
            pass
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()

    def request(self, method, params, timeout=25):
        with self.condition:
            self.seq += 1
            rid = self.seq
            self.pending[rid] = None
            try:
                self.send({'id':rid,'method':method,'params':params})
                until = time.monotonic()+timeout
                while self.pending[rid] is None and not self.closed:
                    remaining = until-time.monotonic()
                    if remaining <= 0:
                        raise BrokerError('Codex 응답 대기 시간이 초과됐습니다.')
                    self.condition.wait(remaining)
                message = self.pending[rid]
                if message is None:
                    raise BrokerError('Codex 연결이 종료되었습니다.')
                if 'error' in message:
                    # Provider errors may contain credentials/context. Never expose raw text.
                    raise BrokerError('Codex가 요청을 거절했습니다. CLI 버전·로그인·구독 사용 한도를 확인하세요.')
                return message.get('result') or {}
            finally:
                self.pending.pop(rid, None)

    def answer(self, thread, timeout=40):
        until = time.monotonic()+timeout
        with self.condition:
            while not self.closed:
                for message in self.events:
                    params = message.get('params') or {}
                    if params.get('threadId') != thread:
                        continue
                    if message['method'] == 'thread/realtime/error':
                        raise BrokerError('Codex Live 연결이 거절되었습니다. 구독 사용 한도와 계정 상태를 확인하세요.')
                    if message['method'] == 'thread/realtime/sdp' and params.get('sdp'):
                        return params['sdp']
                remaining = until-time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(remaining)
        raise BrokerError('Codex Live 음성 연결을 완료하지 못했습니다.')

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
            proc, self.proc = self.proc, None
            directory, self.workdir = self.workdir, None
        if proc:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
            for pipe in (proc.stdin, proc.stdout):
                if pipe:
                    pipe.close()
        if directory:
            directory.cleanup()


def account_status(server):
    account = server.request('account/read', {'refreshToken':False}, 10).get('account') or {}
    if account.get('type') != 'chatgpt':
        raise BrokerError('codex login으로 ChatGPT 구독 계정에 로그인하세요. API 키 로그인은 사용할 수 없습니다.')
    return {'available':True,'reason':None,'plan':str(account.get('planType') or '')}


def readiness():
    if not binary():
        return {'available': False, 'reason': 'HL_ERROR:errCodexMissing', 'authState': 'cli_missing'}
    server = AppServer()
    try:
        server.start()
        account = server.request('account/read', {'refreshToken': False}, 10).get('account') or {}
        if not account:
            return {'available': False, 'reason': 'HL_ERROR:errCodexSignedOut', 'authState': 'signed_out'}
        if account.get('type') != 'chatgpt':
            return {'available': False, 'reason': 'HL_ERROR:errCodexApiLogin', 'authState': 'api_key_login'}
        return {'available': True, 'reason': None, 'authState': 'signed_in', 'plan': str(account.get('planType') or '')}
    except (BrokerError, OSError):
        return {'available': False, 'reason': 'HL_ERROR:errCodexCheck', 'authState': 'check_failed'}
    finally:
        server.close()


class Sessions:
    def __init__(self, factory=AppServer, clock=time.monotonic):
        self.factory, self.clock = factory, clock
        self.lock = threading.RLock()
        self.calls = {}
        self.cancelled = {}
        self.warm = None
        self.closed = False

    def _prepare(self, server):
        server.start()
        account_status(server)
        effective = server.request('config/read', {'includeLayers':False,'cwd':server.workdir.name}).get('config') or {}
        # Read only names from effective config; never return or log config values.
        disabled_mcp = {name:{'enabled':False} for name in (effective.get('mcp_servers') or {})}
        thread = server.request('thread/start', {
            'cwd':server.workdir.name, 'modelProvider':'openai', 'ephemeral':True,
            'approvalPolicy':'never', 'sandbox':'read-only',
            'baseInstructions':SKIP, 'developerInstructions':SKIP,
            'dynamicTools':[], 'environments':[], 'experimentalRawEvents':False,
            'config':{'web_search':'disabled','mcp_servers':disabled_mcp,
                  'features':{'shell_tool':False,'multi_agent':False,'plugins':False,'apps':False,'hooks':False}}})
        thread_id = (thread.get('thread') or {}).get('id')
        if not thread_id:
            raise BrokerError('Codex 음성 세션을 만들지 못했습니다.')
        return thread_id

    def prewarm(self):
        """Keep one unused, tool-isolated thread. No SDP, microphone or voice connection."""
        self.reap()
        with self.lock:
            if self.closed:
                return {'state':'off'}
            if self.warm is not None:
                self.warm['expires'] = self.clock()+45
                return {'state':'ready' if self.warm['ready'] else 'warming'}
            server = self.factory()
            item = {'server':server, 'thread':None, 'ready':False,
                    'created':self.clock(), 'expires':self.clock()+45}
            self.warm = item
            def prepare():
                try:
                    thread_id = self._prepare(server)
                    with self.lock:
                        if self.warm is item and not self.closed and item['expires']>self.clock():
                            item.update(thread=thread_id, ready=True)
                            return
                except Exception:
                    pass  # Warmup is optional; never expose upstream auth/context.
                with self.lock:
                    if self.warm is item:self.warm = None
                server.close()
            worker = threading.Thread(target=prepare, name='hermes-live-prewarm', daemon=True)
            item['worker'] = worker
            worker.start()
            return {'state':'warming'}

    def reap(self):
        with self.lock:
            expired = [key for key, call in self.calls.items() if call['expires'] < self.clock()]
            self.cancelled = {key:expiry for key,expiry in self.cancelled.items() if expiry > self.clock()}
            old = self.warm if self.warm and (self.warm['expires']<=self.clock() or self.clock()-self.warm['created']>=300 or self.warm['server'].closed) else None
            if old:self.warm = None
        if old:old['server'].close()
        for key in expired:
            self.stop(key)

    def start(self, call_id, voice, offer, model="gpt-live-1-codex", persona=PERSONA):
        self.reap()
        with self.lock:
            if self.closed or call_id in self.cancelled or call_id in self.calls:
                raise BrokerError('종료되었거나 중복된 통화입니다.')
            if len(self.calls) >= 2:
                raise BrokerError('진행 중인 Codex 통화를 먼저 종료하세요.')
            prepared = self.warm if self.warm and self.warm['ready'] else None
            if prepared:self.warm = None  # An unused thread is transferred to exactly one call.
            server = prepared['server'] if prepared else self.factory()
            from hermes_constants import get_hermes_home
            call = {'server':server, 'home':str(get_hermes_home()), 'ready':False, 'expires':self.clock()+100, 'thread':prepared['thread'] if prepared else None}
            self.calls[call_id] = call
        try:
            if call['thread'] is None:
                call['thread'] = self._prepare(server)
            else:
                # Never trust standby's old account check after login/logout changes.
                account_status(server)
            thread_id = call['thread']
            server.request('thread/realtime/start', {
                'threadId':thread_id,'transport':{'type':'webrtc','sdp':offer},
                'outputModality':'audio','version':'v3','voice':voice,'model':model,
                'prompt':persona,'realtimeStartInstructions':SKIP,'realtimeEndInstructions':SKIP,
                'includeStartupContext':False,'clientManagedHandoffs':True,'delegationAckFiller':True})
            answer = server.answer(thread_id)
            with self.lock:
                if self.calls.get(call_id) is not call:
                    raise BrokerError('취소된 통화입니다.')
                call['expires'] = self.clock()+45;call['ready']=True
            return {'answer':answer,'callId':call_id,'engine':'codex','handoff':'client'}
        except Exception:
            self.stop(call_id)
            raise

    def active(self,call_id):
        from hermes_constants import get_hermes_home
        with self.lock:
            call=self.calls.get(call_id)
            return bool(call and call.get('ready') and call.get('home')==str(get_hermes_home())
                        and call['expires']>self.clock() and not call['server'].closed)

    def heartbeat(self, call_id):
        self.reap()
        with self.lock:
            call = self.calls.get(call_id)
            if not call or call['server'].closed:
                raise BrokerError('Codex 통화가 종료되었습니다.')
            call['expires'] = self.clock()+45
        return {'ok':True}

    def stop(self, call_id):
        with self.lock:
            self.cancelled[call_id] = self.clock()+120
            call = self.calls.pop(call_id, None)
        if call:
            call['server'].close()
        return {'ok':True}

    def close(self):
        with self.lock:
            self.closed = True
            ids = list(self.calls)
            prepared, self.warm = self.warm, None
        if prepared:prepared['server'].close()
        for key in ids:
            self.stop(key)


sessions = Sessions()
_reaper_stop = threading.Event()
def _reaper():
    while not _reaper_stop.wait(10):
        sessions.reap()
def shutdown():
    _reaper_stop.set()
    sessions.close()
threading.Thread(target=_reaper, daemon=True).start()
atexit.register(shutdown)


def usage_snapshot(server_factory=AppServer):
    """Quota from the SAME Codex-managed account used by voice; never return identity/credentials."""
    server = server_factory()
    try:
        server.start()
        account = account_status(server)
        result = server.request('account/rateLimits/read', {}, 20)
        buckets = result.get('rateLimitsByLimitId') or {'codex': result.get('rateLimits') or {}}
        windows = []
        for bucket_id, bucket in buckets.items():
            if not isinstance(bucket, dict):
                continue
            for key in ('primary', 'secondary'):
                window = bucket.get(key)
                if not isinstance(window, dict):
                    continue
                used = window.get('usedPercent')
                if not isinstance(used, (int, float)) or isinstance(used, bool):
                    continue
                windows.append({'name': str(bucket.get('limitName') or bucket_id)[:100],
                                'usedPercent': max(0, min(100, used)),
                                'windowMinutes': window.get('windowDurationMins'),
                                'resetsAt': window.get('resetsAt')})
        return {'plan': account['plan'], 'windows': windows, 'checkedAt': int(time.time())}
    finally:
        server.close()

class LoginFlow:
    """Codex owns OAuth. Only a short-lived official authorization URL reaches the UI."""
    def __init__(self, factory=AppServer):
        self.factory=factory; self.lock=threading.RLock(); self.server=None
        self.value={'state':'idle'}; self.generation=0

    def status(self):
        with self.lock: return dict(self.value)

    def start(self):
        from urllib.parse import urlparse
        with self.lock:
            if self.value['state'] in ('starting','waiting'): return dict(self.value)
            self.generation+=1; generation=self.generation
            self.value={'state':'starting'}
        def run():
            server=self.factory(); login_id=None
            try:
                server.start()
                with self.lock:
                    if generation!=self.generation: return
                    self.server=server
                result=server.request('account/login/start',{'type':'chatgpt'},20)
                url=result.get('authUrl',''); login_id=result.get('loginId')
                parsed=urlparse(url)
                if parsed.scheme!='https' or parsed.hostname not in ('auth.openai.com','auth0.openai.com','chatgpt.com') or not login_id:
                    raise BrokerError('unsupported login')
                with self.lock:
                    if generation!=self.generation: return
                    self.value={'state':'waiting','url':url}
                deadline=time.monotonic()+300
                while time.monotonic()<deadline:
                    with self.lock:
                        if generation!=self.generation: return
                    with server.condition:
                        events=list(server.events)
                    event=next((e['params'] for e in events if e.get('method')=='account/login/completed' and e.get('params',{}).get('loginId')==login_id),None)
                    if event is not None:
                        if not event.get('success'): raise BrokerError('login failed')
                        account_status(server)
                        with self.lock:
                            if generation==self.generation:self.value={'state':'complete'}
                        return
                    if server.closed: raise BrokerError('login stopped')
                    time.sleep(.25)
                with self.lock:
                    if generation==self.generation:self.value={'state':'expired'}
            except Exception:
                with self.lock:
                    if generation==self.generation:self.value={'state':'error'}
            finally:
                if login_id:
                    try: server.request('account/login/cancel',{'loginId':login_id},3)
                    except Exception: pass
                server.close()
                with self.lock:
                    if self.server is server:self.server=None
        threading.Thread(target=run,daemon=True,name='hermes-live-login').start()
        return self.status()

    def cancel(self):
        with self.lock:
            self.generation+=1;self.value={'state':'cancelled'}
            server=self.server;self.server=None
        if server:server.close()
        return self.status()

login_flow=LoginFlow()
atexit.register(login_flow.cancel)
