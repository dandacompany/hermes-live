"""Bounded local metadata journal. Speech is opt-in, memory-only and expires."""
from collections import deque
from contextlib import contextmanager
from pathlib import Path
import fcntl
import json
import math
import os
import re
import threading
import time
import uuid

EVENTS = set('transport.event runtime.start runtime.health wake.state wake.control wake.expired wake.detected wake.claimed wake.error model.ready model.error audio.sample stt.submitted stt.result call.start call.connected call.end call.error transcript.partial transcript.final command.wake command.goodbye navigation.start navigation.end navigation.error'.split())
FIELDS = set('origin source state reason action owner eventId callId turnId traceId target profile provider enabled muted ready listening level peak rms segments matches elapsedMs gapMs length targets dropped queued visibility wakeState callState lastInputAt lastFinalAt'.split())
TOKEN = re.compile(r'^[\w.:-]{0,100}$', re.UNICODE)

def clean(fields):
    result={}
    for k,v in fields.items():
        if k not in FIELDS: continue
        if isinstance(v,bool): result[k]=v
        elif isinstance(v,(int,float)) and math.isfinite(v): result[k]=max(-1e15,min(1e15,v))
        elif isinstance(v,str) and TOKEN.fullmatch(v) and not re.search(r'(sk-|Bearer|eyJ)',v): result[k]=v
    return result

def redact(text):
    text=re.sub(r'(?i)(?:bearer\s+\S+|sk-[\w-]+|eyJ[\w.-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})','[redacted]',text)
    return text[:500]

class Journal:
    def __init__(self,root,profile='default',clock=time.time,max_bytes=1024*1024):
        self.root=Path(root);self.profile=profile;self.clock=clock;self.max_bytes=max_bytes
        self.lock=threading.RLock();self.details=deque(maxlen=200);self.consent_id='';self.last={};self.write_error=False;self.pruned=0
    @contextmanager
    def disk(self):
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        with os.fdopen(os.open(self.root/'journal.lock',os.O_CREAT|os.O_RDWR,0o600),'a') as f:
            fcntl.flock(f,fcntl.LOCK_EX)
            try:yield
            finally:fcntl.flock(f,fcntl.LOCK_UN)
    def recording_state(self):
        try:
            state=json.loads((self.root/'recording.json').read_text())
            if not isinstance(state,dict) or type(state.get('enabled')) is not bool or not isinstance(state.get('since'),(int,float)) or not math.isfinite(state['since']):raise ValueError('invalid control')
            return state
        except FileNotFoundError:return {'enabled':True,'since':0}
        except (OSError,ValueError,TypeError):
            self.write_error=True
            return {'enabled':False,'since':0}
    def _save(self,name,data):
        path=self.root/name;tmp=self.root/(name+'.tmp')
        with os.fdopen(os.open(tmp,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600),'w') as f:json.dump(data,f)
        os.replace(tmp,path)
    def control(self,recording):
        # The same process/file lock as emit makes stopping a write barrier.
        with self.lock,self.disk():
            self._save('recording.json',{'enabled':bool(recording),'since':self.clock()})
            self._save('detail-consent.json',{'until':0,'id':str(uuid.uuid4())})
            self.details.clear();self.consent_id='';self.write_error=False
        return self.status()
    def consent(self):
        if not self.recording_state()['enabled']:return {'until':0,'id':''}
        try:
            d=json.loads((self.root/'detail-consent.json').read_text())
            if 0 < d['until']-self.clock() <= 300 and isinstance(d['id'],str):return d
        except (OSError,ValueError,KeyError,TypeError):pass
        return {'until':0,'id':''}
    def detail_active(self):return bool(self.consent()['until'])
    def detail(self,seconds):
        with self.lock,self.disk():
            if seconds and not self.recording_state()['enabled']:raise ValueError('recording_disabled')
            d={'until':self.clock()+min(300,max(0,seconds)) if seconds else 0,'id':str(uuid.uuid4())}
            p=self.root/'detail-consent.json';tmp=self.root/'detail-consent.tmp'
            with os.fdopen(os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:json.dump(d,f)
            os.replace(tmp,p);self.details.clear();self.consent_id=d['id']
        if seconds:
            def expire():
                with self.lock:
                    if self.consent_id==d['id']:self.details.clear()
            timer=threading.Timer(seconds,expire);timer.daemon=True;timer.start()
        return d
    def emit(self,event,fields=None,text=None,at=None,detail_id=None):
        try:return self._emit(event,fields,text,at,detail_id)
        except Exception:self.write_error=True
    def _emit(self,event,fields=None,text=None,at=None,detail_id=None):
        if event not in EVENTS:return
        now=self.clock();fields=clean(fields or {})
        row={'id':str(uuid.uuid4()),'at':now,'event':event,**fields,'profile':self.profile}
        if isinstance(at,(int,float)) and math.isfinite(at):row['clientAt']=at
        with self.lock,self.disk():
            state=self.recording_state()
            if not state['enabled']:self.details.clear();return False
            # Reject frontend events queued before the most recent toggle.
            if at is not None and isinstance(at,(int,float)) and at/1000<state['since']:return False
            consent=self.consent()
            if consent['id']!=self.consent_id or not consent['until']:self.details.clear()
            self.consent_id=consent['id']
            if text and event in ('transcript.final','stt.result') and consent['until'] and detail_id==consent['id']:
                self.details.append({**row,'text':redact(text)})
            path=self.root/'events.jsonl';previous=self.root/'events.1.jsonl'
            if now-self.pruned>3600:
                for p in (path,previous):
                    if not p.exists():continue
                    kept=[]
                    for old in p.read_text().splitlines():
                        try:
                            if json.loads(old)['at']>=now-7*86400:kept.append(old)
                        except (ValueError,KeyError,TypeError):pass
                    p.write_text(''.join(x+'\n' for x in kept))
                self.pruned=now
            line=json.dumps(row,ensure_ascii=False)+'\n'
            if path.exists() and path.stat().st_size+len(line.encode())>self.max_bytes:os.replace(path,previous)
            with os.fdopen(os.open(path,os.O_CREAT|os.O_APPEND|os.O_WRONLY,0o600),'a') as f:f.write(line)
            self.last[event]=row;self.write_error=False
            return True
    def snapshot(self,limit=200,after=None,include_text=True):
        with self.lock:
            c={'until':0,'id':''};rows=[]
            try:
                with self.disk():
                    c=self.consent()
                    if c['id']!=self.consent_id or not c['until']:self.details.clear()
                    self.consent_id=c['id']
                    for p in (self.root/'events.1.jsonl',self.root/'events.jsonl'):
                        if not p.exists():continue
                        for line in p.read_text().splitlines():
                            try:
                                r=json.loads(line)
                                if r['at']>=self.clock()-7*86400:rows.append(r)
                            except (ValueError,KeyError,TypeError):pass
            except OSError:self.write_error=True
            # Recover last known state after process restarts, while respecting retention.
            self.last={r['event']:r for r in rows}
            limit=min(500,max(1,limit));reset=False;has_more=False
            if after=='now':selected=[]
            elif after=='empty':
                selected=rows[:limit];has_more=len(rows)>limit;reset=(self.root/'events.1.jsonl').exists()
            elif after:
                index=next((i for i,r in enumerate(rows) if r['id']==after),None)
                reset=index is None
                remaining=rows[index+1:] if index is not None else rows[-limit:]
                selected=remaining[:limit];has_more=len(remaining)>limit
            else:selected=rows[-limit:]
            cursor=selected[-1]['id'] if selected else (rows[-1]['id'] if rows else 'empty')
            selected_ids={r['id'] for r in selected}
            return {'version':1,'profile':self.profile,'now':self.clock(),'recording':self.recording_state()['enabled'],
                    'detailUntil':c['until'],'detailId':c['id'],'cursor':cursor,'reset':reset,'hasMore':has_more,
                    'events':selected,'details':[r for r in self.details if r['id'] in selected_ids] if include_text and c['until'] else [],
                    'last':dict(self.last),'writeError':self.write_error,
                    'retention':{'days':7,'maxBytes':self.max_bytes*2,'detailMemoryOnly':True}}
    def status(self):
        report=self.snapshot(limit=1,include_text=False)
        for key in ('events','details','detailId','reset','hasMore'):report.pop(key,None)
        return report

# The marker exists only in explicitly configured local development installs.
# It is a dotfile, excluded from git/release packaging. No env/global opt-in.
def enabled():return (Path(__file__).parent.parent/'.dev-diagnostics').is_file()
class DisabledJournal:
    write_error=False
    def emit(self,*args,**kwargs):pass
    def consent(self):return {'until':0,'id':''}
    def detail_active(self):return False
_disabled=DisabledJournal()
_journals={};_lock=threading.Lock()
def journal():
    if not enabled():return _disabled
    from hermes_constants import get_default_hermes_root,get_hermes_home
    home=get_hermes_home();root=get_default_hermes_root()
    with _lock:
        key=str(home)
        if key not in _journals:
            _journals[key]=Journal(home/'state/hermes-live/diagnostics',home.name if home!=root else 'default')
        return _journals[key]
