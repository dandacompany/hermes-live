"""Leased local microphone. Every claimed event pins one enabled bot's names."""
import importlib.util
from pathlib import Path
import threading
import time
from uuid import uuid4
from copy import deepcopy

_registry_spec=importlib.util.spec_from_file_location('_lumi_wake_registry',Path(__file__).with_name('wake_registry.py'))
registry=importlib.util.module_from_spec(_registry_spec);_registry_spec.loader.exec_module(registry)

class WakeConflict(RuntimeError):pass

def targets_for(config):
    if 'targets' in config:return config['targets']
    name=registry.wake_name(config['phrase'])
    return [{'target':config['target'],'names':[name],'phrases':[config['phrase']],'display_name':name}]

class WakeService:
    def __init__(self, detector, emit, clock=time.monotonic):
        self.detector,self.emit,self.clock=detector,emit,clock
        self.lock=threading.RLock()
        self.owner=self.config=self.lease=self.event_id=self.event_target=self.claimed_target=None
        self.state='idle';self.deadline=self.not_before=0;self.error=''
        self.detections=self.claims=0

    def status(self,owner):
        with self.lock:
            extra=self.detector.diagnostics() if hasattr(self.detector,'diagnostics') else {}
            state='warming' if self.state=='armed' and extra.get('model_ready') is False else self.state
            selection=self.event_target or self.claimed_target
            return {'state':state,'owned':self.owner==owner,
                'eventId':self.event_id if self.owner==owner else None,
                'target':selection['target'] if selection else (self.config or {}).get('target'),
                'selection':deepcopy(selection) if self.owner==owner else None,'error':self.error}

    def diagnostics(self):
        with self.lock:
            owned=self.lease is not None and self.detector.owns_listener(self.lease)
            device=self.detector.get_input_device_status(self.config) if owned else {}
            return {'state':self.state,'listener_owned':owned,'listening':owned and self.detector.is_listening(),
                'audio_silent':owned and self.detector.audio_is_silent(),'device':device.get('name'),
                'phrase':(self.config or {}).get('phrase'),'detections':self.detections,'claims':self.claims,
                **(self.detector.diagnostics() if hasattr(self.detector,'diagnostics') else {})}

    def _release(self):
        lease=self.lease
        self.owner=self.config=self.lease=self.event_id=self.event_target=self.claimed_target=None
        self.state='idle'
        if lease is not None:self.detector.stop_listening(owner=lease)

    def expire(self):
        with self.lock:
            if self.owner is not None and self.clock()>=self.deadline:self._release()

    def close(self):
        with self.lock:self._release()

    def _start(self,owner,config):
        if not targets_for(config):raise WakeConflict('No enabled bot names')
        self.owner,self.config,self.lease=owner,deepcopy(config),object()
        lease=self.lease
        self.state,self.error='armed',''
        cfg={**config,'provider':config.get('provider','sherpa'),'capture':'local',
             'profile_routing':False,'sensitivity':0.5}
        if config.get('model_dir'):cfg['sherpa']={'model_dir':config['model_dir']}
        try:self.detector.start_listening(lambda:self._detected(lease),owner=lease,config=cfg)
        except Exception:
            self._release();raise

    def control(self,owner,action,config,event_id=None):
        with self.lock:
            self.expire()
            if self.owner is not None and self.owner!=owner:raise WakeConflict('Another window owns the microphone')
            if action=='release':
                self._release();return self.status(owner)
            changed=self.owner is not None and self.config!=config
            if changed:
                if action=='claim':
                    self._release();raise WakeConflict('Bot selection changed before claim')
                # A live call retains its name snapshot; apply edited roster on resume.
                if self.state!='paused' or action=='resume':
                    self._release();self._start(owner,config)
            if self.owner is None:
                if action!='arm':raise WakeConflict('Wake lease expired')
                self._start(owner,config)
            self.deadline=self.clock()+25
            if action=='claim':
                if self.state!='pending' or event_id!=self.event_id:raise WakeConflict('Stale wake event')
                self.claimed_target=self.event_target
                self.state,self.event_id,self.event_target='paused',None,None
                self.claims+=1
            elif action=='pause':
                if not self.detector.pause_listening(owner=self.lease):
                    self._release();raise WakeConflict('Could not pause the wake microphone')
                self.state,self.event_id,self.event_target='paused',None,None
            elif action=='resume' and self.state!='armed':
                self.not_before=self.clock()+2
                if not self.detector.resume_listening(owner=self.lease):
                    self._release();raise WakeConflict('Wake detector lost its lease')
                self.state,self.event_id,self.event_target,self.claimed_target='armed',None,None,None
            elif action not in ('arm','heartbeat','resume'):raise ValueError('Unknown wake action')
            if not self.detector.owns_listener(self.lease):
                self._release();raise WakeConflict('Wake microphone disconnected')
            return self.status(owner)

    def _detected(self,lease):
        with self.lock:
            if lease is not self.lease or self.state!='armed' or self.clock()<self.not_before:return
            targets=targets_for(self.config)
            matched=self.detector.matched_target() if hasattr(self.detector,'matched_target') else self.config['target']
            selection=next((t for t in targets if t['target']==matched),None)
            if selection is None:return
            if not self.detector.pause_listening(owner=lease):return
            self.detections+=1;self.event_id,self.state=str(uuid4()),'pending'
            self.event_target=deepcopy(selection)
            payload={'owner':self.owner,'eventId':self.event_id,'target':selection['target']}
        self.emit(payload)

class DetectorRouter:
    def __init__(self,native):self.native=native;self.active=native
    def start_listening(self,callback,*,owner,config):
        self.current_target=config['target']
        if config.get('provider')=='whisper':
            spec=importlib.util.spec_from_file_location('_lumi_whisper',Path(__file__).with_name('wake_whisper.py'))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            self.active=module.WhisperDetector()
        else:self.active=self.native
        return self.active.start_listening(callback,owner=owner,config=config)
    def matched_target(self):
        if hasattr(self.active,'matched_target'):return self.active.matched_target()
        return self.current_target
    def diagnostics(self):return self.active.diagnostics() if hasattr(self.active,'diagnostics') else {}
    def __getattr__(self,name):return getattr(self.active,name)

_runtime=None
_runtime_lock=threading.Lock()
_sweeper_stop=None

def runtime():
    global _runtime,_sweeper_stop
    with _runtime_lock:
        if _runtime is None:
            from tools import wake_word
            from hermes_cli.plugin_events import broadcast_plugin_event
            _runtime=WakeService(DetectorRouter(wake_word),lambda p:broadcast_plugin_event('hermes-live','wake',p))
            _sweeper_stop=threading.Event();stop,service=_sweeper_stop,_runtime
            def sweep():
                while not stop.wait(1):service.expire()
            threading.Thread(target=sweep,name='hermes-live-wake-lease',daemon=True).start()
        return _runtime

def close():
    global _runtime
    with _runtime_lock:
        if _sweeper_stop:_sweeper_stop.set()
        if _runtime:_runtime.close();_runtime=None
