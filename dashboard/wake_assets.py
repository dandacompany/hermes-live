"""Verified, machine-shared local wake assets. GET never downloads or records audio."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'
MODELS = {
 'base': (147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'),
 'small': (487601967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'),
 'large-v3-turbo': (1624555275, '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'),
 'large-v3': (3095033483, '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'),
}
ENGINE_SHA = '324086695d8316e06eeb65e590404da046c43556bf7789017f70e4d209f1b1a9'
_verified = {}
_guard = threading.Lock()

class SetupError(RuntimeError): pass

def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def verified(path, size, sha):
    try:
        stat = path.stat()
        if not path.is_file() or stat.st_size != size: return False
        key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, sha)
        with _guard:
            if key in _verified: return True
        if digest(path) != sha: return False
        with _guard:
            if len(_verified) > 32: _verified.clear()
            _verified[key] = True
        return True
    except OSError: return False

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.setup-')
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out); out.flush(); os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def read_json(path):
    try:
        value=json.loads(path.read_text())
        return value if isinstance(value,dict) else {}
    except (OSError, ValueError): return {}

class Assets:
    def __init__(self, root, home=None, resources=None):
        self.root = Path(root)
        self.home = Path(home) if home else Path.home()
        self.resources = Path(resources) if resources else Path(__file__).parent/'resources/whisper/darwin-arm64'
        self.thread = None

    @property
    def supported(self): return platform.system() == 'Darwin' and platform.machine() == 'arm64'

    def engine(self):
        path = self.resources/'whisper-server'
        return path if self.supported and verified(path, 8408000, ENGINE_SHA) and os.access(path, os.X_OK) else None

    def discover(self, cfg):
        model = str(cfg.get('wake_whisper_model') or 'small')
        if model not in MODELS: raise SetupError('modelUnsupported')
        size, sha = MODELS[model]
        roots = []
        explicit = str(cfg.get('wake_whisper_models') or '').strip()
        if explicit: roots.append(Path(explicit).expanduser())
        roots += [self.root/'models', self.home/'.local/share/whisper/models']
        path = next((p/f'ggml-{model}.bin' for p in roots if verified(p/f'ggml-{model}.bin', size, sha)), None)
        return model, path

    def progress(self):
        value = read_json(self.root/'progress.json')
        if value.get('state') in ('downloading', 'verifying', 'preparing'):
            try:
                with open(self.root/'install.lock', 'a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
                    value = {**value, 'state':'interrupted', 'error':'downloadInterrupted'}
            except BlockingIOError: pass
        return value

    def status(self, cfg):
        model, path = self.discover(cfg)
        engine = self.engine()
        receipt = read_json(self.root/'prepared.json')
        fingerprint = self.fingerprint(path) if path else ''
        return {'supported':self.supported, 'engine':bool(engine), 'model':model,
                'bytes':MODELS[model][0], 'installed':path is not None,
                'source':'existing' if path and path.parent != self.root/'models' else 'managed',
                'prepared':bool(engine and path and receipt.get('fingerprint') == fingerprint),
                'progress':self.progress()}

    def fingerprint(self, path):
        s = path.stat()
        return hashlib.sha256(f'{path.resolve()}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}:{ENGINE_SHA}'.encode()).hexdigest()

    def resolve(self, cfg):
        model, path = self.discover(cfg)
        engine = self.engine()
        if not self.supported: raise SetupError('unsupportedPlatform')
        if not engine: raise SetupError('engineMissing')
        if not path: raise SetupError('modelMissing')
        return {'native':True, 'engine':str(engine), 'model_file':str(path),
                'model':model, 'model_sha':MODELS[model][1], 'engine_sha':ENGINE_SHA}

    def cancel(self):
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root/'cancel').touch()

    def start(self, cfg):
        if not self.engine(): raise SetupError('engineMissing' if self.supported else 'unsupportedPlatform')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        model, path = self.discover(cfg)
        lock = open(self.root/'install.lock', 'a')
        try: fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close(); return self.progress()
        try:
            (self.root/'cancel').unlink(missing_ok=True)
            model, path = self.discover(cfg)
            self._write('preparing' if path else 'downloading', model)
        except Exception:
            lock.close()
            raise
        def run():
            try:
                if path is None: self._download(model)
                self._cancelled()
                self._write('preparing', model)
                self._probe(self.resolve(cfg))
                self._cancelled()
                _, ready = self.discover(cfg)
                atomic_json(self.root/'prepared.json', {'fingerprint':self.fingerprint(ready)})
                self._write('ready', model)
            except SetupError as exc: self._write('cancelled' if str(exc)=='downloadCancelled' else 'error', model, error=str(exc))
            except PermissionError: self._write('error', model, error='filePermission')
            except OSError as exc: self._write('error', model, error='diskSpace' if exc.errno==28 else 'downloadFailed')
            except Exception: self._write('error', model, error='downloadFailed')
            finally: lock.close()
        self.thread = threading.Thread(target=run, daemon=True, name='hermes-live-model-setup')
        self.thread.start()
        return self.progress()

    def _write(self, state, model, received=0, error=''):
        atomic_json(self.root/'progress.json', {'state':state, 'model':model, 'received':received,
                    'total':MODELS[model][0], 'error':error})

    def _cancelled(self):
        if (self.root/'cancel').exists(): raise SetupError('downloadCancelled')

    def _download(self, model):
        size, sha = MODELS[model]
        if shutil.disk_usage(self.root).free < size + 64*1024*1024: raise SetupError('diskSpace')
        dest = self.root/'models'/f'ggml-{model}.bin'
        dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = dest.with_suffix('.partial')
        url = f'https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/ggml-{model}.bin'
        count = 0; hash_ = hashlib.sha256(); deadline = time.monotonic()+1800
        try:
            with urllib.request.urlopen(url, timeout=15) as response, open(temp, 'wb') as out:
                os.chmod(temp, 0o600)
                while True:
                    self._cancelled()
                    if time.monotonic()>deadline: raise SetupError('downloadFailed')
                    block = response.read(1024*1024)
                    if not block: break
                    count += len(block)
                    if count>size: raise SetupError('modelIntegrity')
                    hash_.update(block); out.write(block)
                    self._write('downloading', model, count)
                out.flush(); os.fsync(out.fileno())
            self._write('verifying', model, count)
            if count!=size or hash_.hexdigest()!=sha: raise SetupError('modelIntegrity')
            self._cancelled(); os.replace(temp, dest)
        finally: temp.unlink(missing_ok=True)

    def _probe(self, config):
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('wake-native-worker.py')),
                   json.dumps({**config, 'targets':[], 'probe':True})],
                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        deadline = time.monotonic()+90
        try:
            while process.poll() is None:
                self._cancelled()
                if time.monotonic()>deadline: raise SetupError('modelStartFailed')
                time.sleep(.1)
            result = process.stdout.read(4096)
            if process.returncode or not json.loads(result).get('ready'): raise SetupError('modelStartFailed')
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            process.stdout.close()

def assets():
    from hermes_constants import get_default_hermes_root
    return Assets(get_default_hermes_root()/'cache/hermes-live/whisper')
