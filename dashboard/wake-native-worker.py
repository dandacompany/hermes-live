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

def match_target(text, targets):
    matches = {t['target'] for t in targets if any(matches_phrase(text,p) for p in t['phrases'])}
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
                    text=transcribe(pcm);target=match_target(text,cfg['targets'])
                    send({'id':item['id'],'target':target,'length':len(text),**({'text':text[:500]} if item.get('detail') else {}),'elapsedMs':round((time.monotonic()-started)*1000)})
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
