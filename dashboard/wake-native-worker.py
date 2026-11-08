"""Standalone stdlib whisper.cpp client. No Node, BotIn imports, PCM files or paid API."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
import wave
import re

def normalized(text):
    return re.sub(r'[\s,，.!。！]', '', unicodedata.normalize('NFKC', text).lower())

def matches_phrase(text, phrase):
    value, command = normalized(text), normalized(phrase)
    return bool(value and command) and len(value)%len(command)==0 and command*(len(value)//len(command))==value

# Tolerant fallback, used only when no exact phrase matches: Whisper often drops or mangles a short
# leading "Hey" ("a jarvis", "e jarvis", "jarvis") or adds punctuation ("Hey, Jarvis?"). Spaces and
# punctuation are ignored. A complete goodbye to any bot ("bye cora", or "um, bye cora": the goodbye
# check alone drops the leading fillers goodbye.ts drops) never wakes one. Otherwise the first tier
# that fits any bot decides (one bot, or none if it fits several): the name after a whole greeting
# ("Hey", "헤이"); then the name after up to 3 Latin letters in total, so a short word before the
# name ("I'm", "I am", "run", "ok", "the", "um") also wakes, longer sentences do not; then the name alone.
# greeting_required only disables bare names; it does not restore exact-only matching.
BARE_NAME_MIN = 5  # a name alone wakes only from 5 loose characters, so "alf" or "fred" said in passing do not
GOODBYE_PREFIXES = {'bye', 'by', '바이', '바일', '파일'}  # src/goodbye.ts: "Bye <name>" ends a call, never starts one
GOODBYE_FILLERS = re.compile(r'^(?:(?:음|어|um|uh)[\s,.…]+)+', re.IGNORECASE)  # src/goodbye.ts utterance()
GREETINGS = {'hey', '헤이'}  # the wake_registry.py phrase prefixes "Hey " and "헤이 " in loose form
TIERS = ('greeting', 'remnant', 'bare')  # tolerant readings, in the order they decide

def loose(text):
    return re.sub(r'[\s,，.!。！?？\'’"\-:;…]', '', unicodedata.normalize('NFKC', text).lower())

def name_tier(value, key, names, greeting_required=False):
    # A name with no letter left ("---", "12345") never matches loosely, so "Hey" alone cannot wake it.
    if not any(c.isalpha() for c in key) or not value.endswith(key): return None
    rest = value[:len(value)-len(key)]
    if rest in GREETINGS: return 'greeting'  # "Hey, Theo?" is Theo even when another bot is "Heytheo"
    # A Latin greeting remnant ("he", "a", "ehi"), never a Hangul one or a goodbye prefix, and never a
    # bot's own name read as a remnant plus a shorter alias ("al"+"fred" is the bare name "alfred").
    if re.fullmatch(r'[a-z]{1,3}', rest) and rest not in GOODBYE_PREFIXES and value not in names: return 'remnant'
    if not rest and not greeting_required and len(key) >= BARE_NAME_MIN: return 'bare'
    return None

def tolerant_matches(text, targets, greeting_required=False):
    value = loose(text)
    names = {loose(n) for t in targets for n in t.get('names',[])}
    # "bye cora" is a goodbye to Cora, so it wakes no bot, not even "b" + another bot "Yecora". Fillers
    # are dropped here only: "um cora" still wakes Cora below, "um, bye cora" is a goodbye.
    said = loose(GOODBYE_FILLERS.sub('', text, count=1))
    if any(said == loose(p)+key for p in GOODBYE_PREFIXES for key in names): return set()
    found = {}
    for t in targets:
        for n in t.get('names',[]):
            tier = name_tier(value, loose(n), names, greeting_required)
            if tier: found.setdefault(tier, set()).add(t['target'])
    return next((found[tier] for tier in TIERS if tier in found), set())

def match_target(text, targets, greeting_required=False):
    # Exact phrases decide first, ambiguity included, so they keep the result of the exact-only matcher.
    matches = {t['target'] for t in targets if any(matches_phrase(text,p) for p in t['phrases'])}
    if not matches:
        matches = tolerant_matches(text, targets, greeting_required)
    return next(iter(matches)) if len(matches)==1 else None

def send(value): print(json.dumps(value), flush=True)

def main():
    cfg = json.loads(sys.argv[1]); child = None
    def stop(*_): raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    with tempfile.TemporaryDirectory(prefix='hermes-live-whisper-') as work:
        try:
            for key in ('model', 'engine'):
                path = cfg['model_file'] if key=='model' else cfg['engine']
                with open(path, 'rb') as f:
                    if hashlib.file_digest(f, 'sha256').hexdigest()!=cfg[key+'_sha']: raise ValueError('integrity')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
            token = secrets.token_hex(32)
            endpoint = f'http://127.0.0.1:{port}'
            # Ignore proxy env vars for loopback audio, and never forward user secrets.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            child = subprocess.Popen([cfg['engine'], '--host','127.0.0.1','--port',str(port),
                    '-m',cfg['model_file'],'-l','ko','--tmp-dir',work], cwd=work,
                    env={'PATH':'/usr/bin:/bin','HOME':work,'BOTIN_WHISPER_TOKEN':token},
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            def request(path, data=None, content_type=None):
                headers={'Authorization':'Bearer '+token}
                if content_type: headers['Content-Type']=content_type
                req=urllib.request.Request(endpoint+path, data=data, headers=headers)
                with opener.open(req, timeout=20 if data else .5) as response:
                    raw=response.read(1000001)
                    if len(raw)>1000000: raise ValueError('response size')
                    return json.loads(raw)
            start=time.monotonic()
            while True:
                if child.poll() is not None or time.monotonic()-start>60: raise ValueError('start')
                try:
                    if request('/health').get('status')=='ok': break
                except Exception: pass
                time.sleep(.1)
            def transcribe(pcm):
                wav=io.BytesIO()
                with wave.open(wav,'wb') as f:
                    f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(pcm)
                boundary=secrets.token_hex(16)
                fields={'response_format':'json','language':'ko','temperature':'0.0',
                        'prompt':', '.join(dict.fromkeys(n for t in cfg['targets'] for n in t['names']))[:400]}
                body=b''
                for name,value in fields.items():
                    body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
                body+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="turn.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()+wav.getvalue()+f'\r\n--{boundary}--\r\n'.encode()
                result=request('/inference',body,'multipart/form-data; boundary='+boundary)
                if not isinstance(result.get('text'),str): raise ValueError('response')
                return result['text']
            transcribe(bytes(32000))
            send({'ready':True,'elapsedMs':round((time.monotonic()-start)*1000)})
            if cfg.get('probe'): return
            for line in sys.stdin:
                if len(line)>300000: raise ValueError('size')
                item=json.loads(line); pcm=base64.b64decode(item['pcm'],validate=True)
                if not 6400<=len(pcm)<=192000 or len(pcm)%2: raise ValueError('PCM')
                started=time.monotonic()
                try:
                    target=match_target(transcribe(pcm),cfg['targets'],bool(cfg.get('greeting_required')))
                    send({'id':item['id'],'target':target,'elapsedMs':round((time.monotonic()-started)*1000)})
                except Exception: send({'id':item['id'],'error':'local_transcription_failed'})
        finally:
            if child and child.poll() is None:
                child.terminate()
                try: child.wait(timeout=3)
                except subprocess.TimeoutExpired: child.kill();child.wait()

if __name__=='__main__':
    try: main()
    except Exception:
        send({'error':'local_worker_failed'}); sys.exit(1)
