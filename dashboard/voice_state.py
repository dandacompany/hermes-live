"""Read-only call state for external controllers (for example hardware key launchers).

The desktop plugin reports its call phase; this module validates the report and
atomically writes ``<default hermes root>/state/hermes-live/voice-state.json``.
No transcript, session id or credential is accepted or written.
"""
from __future__ import annotations

import contextlib
import fcntl
import hmac
import json
import os
import re
import secrets
import stat
import tempfile
from pathlib import Path

STATE_RELATIVE='state/hermes-live/voice-state.json'
# Shared secret for hermes://hermes-live/voice links: one line, 43 base64url characters, mode 600.
TOKEN_RELATIVE='state/hermes-live/voice-token'
_TOKEN=re.compile(r'[A-Za-z0-9_-]{43}')
INTERVAL_MS=2000
STALE_AFTER_MS=6000
STATUSES={'off','connecting','in_call','unknown'}
ACTIONS={'start','stop','toggle'}
OUTCOMES={'accepted','rejected','failed'}
REASONS={'bad_request','bad_token','auth_unavailable','duplicate','too_soon','remote','transitioning','unknown','already_on','already_off','paused','busy','no_chat','wrong_bot','scope_changed','start_failed'}
_PROFILE=re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')
_NONCE=re.compile(r'[A-Za-z0-9_-]{8,64}')
_INSTANCE=re.compile(r'[A-Za-z0-9-]{8,64}')
_REPORT_KEYS={'v','instance','status','profile','last'}
_LAST_KEYS={'nonce','action','profile','outcome','reason','at'}

def _match(pattern,value):return isinstance(value,str) and pattern.fullmatch(value) is not None
def _optional(pattern,value):return value is None or _match(pattern,value)
def _int(value):return type(value) is int and value>=0

def validate_last(last):
    if last is None:return None
    if not isinstance(last,dict) or set(last)!=_LAST_KEYS:raise ValueError('invalid last command')
    if not _optional(_NONCE,last['nonce']) or not _optional(_PROFILE,last['profile']):raise ValueError('invalid last command')
    if last['action'] is not None and last['action'] not in ACTIONS:raise ValueError('invalid last command')
    if last['outcome'] not in OUTCOMES or not _int(last['at']):raise ValueError('invalid last command')
    reason=last['reason']
    if (reason is None)!=(last['outcome']=='accepted') or (reason is not None and reason not in REASONS):raise ValueError('invalid last command')
    return dict(last)

def validate_report(payload):
    if not isinstance(payload,dict) or set(payload)!=_REPORT_KEYS:raise ValueError('invalid report')
    if type(payload['v']) is not int or payload['v']!=1 or not _match(_INSTANCE,payload['instance']):raise ValueError('invalid report')
    status=payload['status'];profile=payload['profile']
    if status not in STATUSES:raise ValueError('invalid report')
    if status in ('connecting','in_call'):
        if not _match(_PROFILE,profile):raise ValueError('invalid report')
    elif profile is not None:raise ValueError('invalid report')
    return {'status':status,'profile':profile,'instance':payload['instance'],'last':validate_last(payload['last'])}

@contextlib.contextmanager
def _locked(path:Path):
    with open(path.with_name('.voice-state.lock'),'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:yield
        finally:fcntl.flock(lock,fcntl.LOCK_UN)

def _atomic_write(path:Path,text:str,prefix:str):
    fd,temp=tempfile.mkstemp(dir=path.parent,prefix=prefix)
    try:
        with os.fdopen(fd,'w') as out:
            out.write(text);out.flush();os.fsync(out.fileno())
        os.chmod(temp,0o600);os.replace(temp,path)
    finally:
        if os.path.exists(temp):os.unlink(temp)

def _read_token(path:Path):
    try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    except OSError:return None
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>64:return None
        text=os.read(fd,65).decode('ascii')
    except (OSError,UnicodeDecodeError):return None
    finally:os.close(fd)
    token=text[:-1] if text.endswith('\n') else text
    return token if _TOKEN.fullmatch(token) else None

def _token(path:Path):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with _locked(path):
        token=_read_token(path)
        if token is None:
            # Missing, malformed, foreign-owned, symlinked or readable by others: replace it.
            token=secrets.token_urlsafe(32)
            _atomic_write(path,token+'\n','.voice-token-')
        return token

def ensure_token(path:Path)->None:
    _token(path)

def verify_token(path:Path,candidate)->bool:
    token=_token(path)
    if not isinstance(candidate,str) or not _TOKEN.fullmatch(candidate):return False
    return hmac.compare_digest(candidate.encode('ascii'),token.encode('ascii'))

def _previous(path:Path):
    try:
        data=json.loads(path.read_text())
        return data if isinstance(data,dict) and data.get('v')==1 else None
    except (OSError,ValueError):return None

def write_report(path:Path,payload,now_ms:int):
    report=validate_report(payload)
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with _locked(path):
        previous=_previous(path)
        if previous:
            fresh=isinstance(previous.get('updatedAt'),int) and now_ms-previous['updatedAt']<=STALE_AFTER_MS
            # Secondary windows also report "off"; they must not hide the window that owns a live call.
            if fresh and previous.get('instance')!=report['instance'] and previous.get('status') in ('connecting','in_call') and report['status'] in ('off','unknown'):
                return {'written':False,'state':previous}
        last=report['last'] if report['last'] is not None else (previous or {}).get('last')
        state={'v':1,'status':report['status'],'profile':report['profile'],'updatedAt':now_ms,'intervalMs':INTERVAL_MS,'staleAfterMs':STALE_AFTER_MS,'instance':report['instance'],'last':last}
        _atomic_write(path,json.dumps(state,ensure_ascii=False),'.voice-state-')
        return {'written':True,'state':state}
