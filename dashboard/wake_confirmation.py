"""Bounded local verification of an already captured short utterance. No mic access."""
import atexit
import base64
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

class ConfirmationError(Exception):pass

class Worker:
    def __init__(self, config):
        self.messages=queue.Queue(maxsize=4)
        self.proc=subprocess.Popen([sys.executable,str(Path(__file__).with_name('wake-native-worker.py')),
            json.dumps({**config['whisper_native'],'targets':config['targets']})],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1,
            env={'HOME':str(Path.home()),'PATH':'/usr/bin:/bin'})
        self.ready=False;self.closed=False
        threading.Thread(target=self._read,daemon=True,name='live-wake-confirm-reader').start()
    def _read(self):
        try:
            while True:
                line=self.proc.stdout.readline(4097)
                if not line:break
                if len(line)>4096:raise ValueError('size')
                self.messages.put_nowait(json.loads(line))
        except Exception:pass
        finally:
            try:self.messages.put_nowait({'error':'worker_stopped'})
            except queue.Full:pass
    def _next(self,deadline,valid):
        while time.monotonic()<deadline:
            if not valid():raise ConfirmationError('cancelled')
            try:return self.messages.get(timeout=min(.1,max(.001,deadline-time.monotonic())))
            except queue.Empty:pass
        raise ConfirmationError('timeout')
    def verify(self,candidate,pcm,deadline,valid):
        if not self.ready:
            message=self._next(deadline,valid)
            if not message.get('ready'):raise ConfirmationError('model_unavailable')
            self.ready=True
        if not valid():raise ConfirmationError('cancelled')
        self.proc.stdin.write(json.dumps({'id':candidate,'pcm':pcm,'detail':False})+'\n');self.proc.stdin.flush()
        message=self._next(deadline,valid)
        if message.get('id')!=candidate or message.get('error'):raise ConfirmationError('transcription_failed')
        return message.get('target')
    def close(self):
        if self.closed:return
        self.closed=True
        if self.proc.poll() is None:
            self.proc.terminate()
            try:self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait(timeout=2)
        self.proc.stdin.close();self.proc.stdout.close()

class ConfirmationService:
    def __init__(self,factory=Worker,clock=time.monotonic):
        self.factory=factory;self.clock=clock;self.lock=threading.RLock();self.busy=threading.Lock()
        self.worker=None;self.owner=None;self.signature=None;self.touched=0;self.cancelled={};self.seen={};self.last_request={}
        self.current=None
    def _prune(self):
        now=self.clock()
        for table in (self.cancelled,self.seen,self.last_request):
            for key,expiry in list(table.items()):
                if expiry<=now:table.pop(key,None)
    def cancel(self,call,candidate):
        with self.lock:
            self._prune()
            if len(self.cancelled)>=128:self.cancelled.pop(next(iter(self.cancelled)))
            self.cancelled[(call,candidate)]=self.clock()+15
    def stop(self,call=None):
        with self.lock:
            if call is not None and self.owner!=call:return
            if self.current:self.cancelled[self.current]=self.clock()+15
            worker,self.worker=self.worker,None;self.owner=None;self.signature=None
        if worker:worker.close()
    def reap(self):
        with self.lock:
            old=self.owner if self.worker and self.clock()-self.touched>30 and self.current is None else None
            if old:self.stop(old)
    def verify(self,call,candidate,target,pcm,config,active):
        try:raw=base64.b64decode(pcm,validate=True)
        except (ValueError,TypeError):raise ConfirmationError('invalid_audio') from None
        if not 10240<=len(raw)<=160000 or len(raw)%2:raise ConfirmationError('invalid_audio')
        del raw
        if not config.get('whisper_native'):raise ConfirmationError('model_unavailable')
        if not active():raise ConfirmationError('call_ended')
        signature=json.dumps({'native':config['whisper_native'],'targets':config['targets']},sort_keys=True)
        if not self.busy.acquire(blocking=False):raise ConfirmationError('busy')
        key=(call,candidate);started=self.clock()
        try:
            with self.lock:
                self._prune()
                if key in self.cancelled:raise ConfirmationError('cancelled')
                if key in self.seen:raise ConfirmationError('duplicate')
                if call in self.last_request:raise ConfirmationError('rate_limited')
                self.seen[key]=self.clock()+30;self.last_request[call]=self.clock()+1
                if self.owner!=call or self.signature!=signature:
                    self.stop();self.worker=self.factory(config);self.owner=call;self.signature=signature
                worker=self.worker;self.current=key;self.touched=self.clock()
            def valid():
                with self.lock:return self.worker is worker and self.current==key and key not in self.cancelled and active()
            actual=worker.verify(candidate,pcm,time.monotonic()+6,valid)
            if not valid():raise ConfirmationError('cancelled')
            return {'candidateId':candidate,'target':actual if actual==target else None,
                    'reason':'confirmed' if actual==target else 'disagreed','elapsedMs':round((self.clock()-started)*1000)}
        except ConfirmationError as error:
            if str(error) in ('timeout','cancelled','transcription_failed','model_unavailable'):self.stop(call)
            raise
        except Exception:
            self.stop(call);raise ConfirmationError('model_unavailable') from None
        finally:
            with self.lock:
                if self.current==key:self.current=None
                self.touched=self.clock()
            self.busy.release()

service=ConfirmationService();_shutdown=threading.Event()
def reap():
    while not _shutdown.wait(5):service.reap()
threading.Thread(target=reap,daemon=True,name='live-wake-confirm-reaper').start()
def shutdown():_shutdown.set();service.stop()
atexit.register(shutdown)
