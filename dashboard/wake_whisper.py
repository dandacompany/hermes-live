"""Local Whisper adapter using Hermes capture and the same machine-wide mic lock."""
import base64
from collections import deque
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

_registry_spec = importlib.util.spec_from_file_location('_lumi_wake_registry', Path(__file__).with_name('wake_registry.py'))
registry = importlib.util.module_from_spec(_registry_spec)
_registry_spec.loader.exec_module(registry)

class UtteranceGate:
    """Bounded energy gate: keep short utterances, discard long speech until silence."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.pre = deque(maxlen=3)
        self.frames = []
        self.voiced = self.quiet = 0
        self.discarding = False
        self.noise = 45.0

    def feed(self, frame):
        import numpy as np
        rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
        voice = rms > max(160.0, self.noise * 3)
        if not voice:
            self.noise = .98 * self.noise + .02 * min(rms, 160)
        if self.discarding:
            self.quiet = 0 if voice else self.quiet + 1
            if self.quiet >= 7:
                self.reset()
            return None
        if not self.frames:
            self.pre.append(frame.copy())
            if voice:
                self.frames = list(self.pre)
                self.voiced = 1
            return None
        self.frames.append(frame.copy())
        self.voiced += int(voice)
        self.quiet = 0 if voice else self.quiet + 1
        if len(self.frames) >= 63:  # five seconds: never split a long sentence into a wake tail
            self.frames = []
            self.discarding = True
            return None
        if self.quiet >= 7:
            result = np.concatenate(self.frames) if self.voiced >= 4 else None
            self.reset()
            return result
        return None

class WhisperEngine:
    frame_length = 1280

    def __init__(self, cfg):
        self.lock = threading.RLock()
        self.gate = UtteranceGate()
        self.generation = 0
        self.pending = None
        self.matched = False
        self.last_target = None
        self.targets = cfg.get('targets') or [{'target':cfg['target'],'names':[registry.wake_name(cfg['phrase'])],'phrases':[cfg['phrase']]}]
        self.ready = False
        self.error = ''
        self.closed = False
        self.requests = self.matches = self.last_ms = self.warmup_ms = self.peak = 0
        self.last_rms = 0.0
        self.started = time.monotonic()
        native = cfg.get('whisper_native')
        if native:
            command = [sys.executable, str(Path(__file__).with_name('wake-native-worker.py')),
                       json.dumps({**native, 'targets':self.targets, 'language':cfg.get('whisper_language','en')})]
            env = {'HOME':str(Path.home()),'PATH':'/usr/bin:/bin'}
        else:
            worker = Path(__file__).with_name('wake-whisper-worker.mjs')
            node = cfg['whisper_node']
            options = {'module':cfg['whisper_module'],'models':cfg['whisper_models'],
                       'engine':cfg['whisper_engine'],'model':cfg['whisper_model'],'targets':self.targets,
                       'language':cfg.get('whisper_language','en')}
            command = [node,str(worker),json.dumps(options)]
            env = {'HOME':str(Path.home()),'PATH':str(Path(node).parent)+':/usr/bin:/bin'}
        self.proc = subprocess.Popen(command,stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1,env=env)
        threading.Thread(target=self._read,daemon=True,name='lumi-whisper-results').start()

    def _read(self):
        try:
            for line in self.proc.stdout:
                if len(line) > 4096:
                    raise ValueError('oversized result')
                result = json.loads(line)
                with self.lock:
                    if self.closed:
                        return
                    if result.get('ready'):
                        self.ready = True
                        self.warmup_ms = result.get('elapsedMs',0)
                    elif result.get('id') == self.pending and self.pending is not None:
                        self.pending = None
                        if not str(result['id']).startswith(f'{self.generation}:'):
                            continue
                        self.last_ms = result.get('elapsedMs',0)
                        if result.get('error'):
                            self.error = 'transcription_failed'
                        elif result.get('target') in {t['target'] for t in self.targets}:
                            self.last_target = result['target']
                            self.matched = True
                            self.matches += 1
                    elif result.get('error') and 'id' not in result:
                        self.error = 'worker_failed'
        except Exception:
            with self.lock:
                self.error = 'worker_failed'
        finally:
            with self.lock:
                if not self.closed:
                    self.error = self.error or 'worker_stopped'

    def reset(self):
        with self.lock:
            self.generation += 1
            # Keep pending until its response arrives; generation in the ID rejects stale text.
            self.matched = False
            self.last_target = None
            self.gate.reset()

    def process(self, frame):
        import numpy as np
        with self.lock:
            if self.closed:
                return False
            self.peak = max(self.peak,int(np.max(np.abs(frame.astype(np.int32)))))
            self.last_rms = round(float(np.sqrt(np.mean(frame.astype(np.float32) ** 2))),1)
            if not self.ready and time.monotonic()-self.started > 90:
                self.error = 'model_start_timeout'
            if self.error or not self.ready:
                return False
            if self.matched:
                self.matched = False
                self.gate.reset()
                return True
            if self.pending is not None:
                return False
            pcm = self.gate.feed(frame)
            if pcm is None:
                return False
            self.requests += 1
            self.pending = f'{self.generation}:{self.requests}'
            try:
                self.proc.stdin.write(json.dumps({'id':self.pending,'pcm':base64.b64encode(pcm.astype('<i2').tobytes()).decode()})+'\n')
                self.proc.stdin.flush()
            except Exception:
                self.error = 'worker_pipe_failed'
            return False

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.generation += 1
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=2)
        self.proc.stdin.close()
        self.proc.stdout.close()

    def diagnostics(self):
        with self.lock:
            return {'model_ready':self.ready,'model_error':self.error,'segments':self.requests,
                    'matches':self.matches,'last_transcription_ms':self.last_ms,
                    'model_warmup_ms':self.warmup_ms,'peak':self.peak,'rms':self.last_rms}

class WhisperDetector:
    def __init__(self):
        self.owner = self.listener = self.handle = None
        self.paused = False

    def start_listening(self, callback, *, owner, config):
        from tools.wake_word import WakeWordDetector
        from hermes_constants import get_default_hermes_root
        if self.owner is not None:
            raise RuntimeError('microphone already owned')
        path = get_default_hermes_root()/'runtime/wake-word.lock'
        path.parent.mkdir(parents=True,exist_ok=True)
        handle = open(path,'a+b')
        try:
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except Exception:
            handle.close()
            raise
        self.handle, self.owner = handle, owner
        self.paused = False
        engine = None
        try:
            engine = WhisperEngine(config)
            self.listener = WakeWordDetector(engine,callback,input_device=config['input_device'])
            self.listener.start()
        except Exception:
            if engine is not None and self.listener is None:
                engine.close()
            self.stop_listening(owner=owner)
            raise
        return self.listener

    def owns_listener(self, owner):
        return (self.owner is owner and self.listener is not None and not self.listener.engine.error
                and (self.paused or self.listener.running))

    def pause_listening(self, *, owner):
        if not self.owns_listener(owner):return False
        self.listener.pause()
        self.listener.engine.reset()
        self.paused = not self.listener.running
        return not self.listener.running

    def resume_listening(self, *, owner):
        if not self.owns_listener(owner):return False
        self.listener.resume()
        self.paused = False
        return self.listener.running

    def stop_listening(self, *, owner):
        if owner is not self.owner:return False
        self.owner = None
        try:
            if self.listener:self.listener.stop()
        finally:
            self.listener = None
            if self.handle:self.handle.close()
            self.handle = None
        return True

    def matched_target(self):return self.listener.engine.last_target if self.listener else None
    def is_listening(self):return bool(self.listener and self.listener.running)
    def audio_is_silent(self):return bool(self.listener and self.listener.audio_silent)
    def get_input_device_status(self, cfg=None):return self.listener.input_device_details if self.listener else {}
    def diagnostics(self):return self.listener.engine.diagnostics() if self.listener else {}
