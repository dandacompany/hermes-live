"""Scoped token and WebRTC signaling broker; permanent keys stay on the backend."""
from __future__ import annotations

import importlib.util
import sys
import json
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

import httpx
import time
from fastapi import APIRouter, Body, HTTPException, Response, Query
from pydantic import BaseModel, ConfigDict, Field
from uuid import UUID

_spec = importlib.util.spec_from_file_location(__name__ + '_codex', Path(__file__).with_name('codex_broker.py'))
codex = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = codex
_spec.loader.exec_module(codex)


_diag_spec=importlib.util.spec_from_file_location('hermes_live_diagnostics',Path(__file__).with_name('diagnostics.py'))
if 'hermes_live_diagnostics' not in sys.modules:
    _diag_module=importlib.util.module_from_spec(_diag_spec)
    sys.modules[_diag_spec.name]=_diag_module
    _diag_spec.loader.exec_module(_diag_module)
diag=sys.modules['hermes_live_diagnostics']

router = APIRouter()
PROVIDERS = {
    'codex': {
        'name':'Codex 구독 · GPT Live',
        'models':[{'id':'gpt-live-1-codex','name':'GPT Live 1 (Codex 구독)'}],
        'voices':codex.VOICES, 'sampleRate':48000,
    },
    'gemini': {
        'name': 'Google Gemini Live',
        'models': [
            {'id': 'gemini-3.8-live', 'name': 'Gemini 3.8 Live'},
            {'id': 'gemini-3.1-flash-live-preview', 'name': 'Gemini 3.1 Flash Live (Preview)'},
            {'id': 'gemini-2.5-flash-native-audio-latest', 'name': 'Gemini 2.5 Flash Native Audio'},
        ],
        'voices': ['Kore', 'Aoede', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Zephyr'],
        'sampleRate': 16000,
    },
    'grok': {
        'name': 'xAI Grok Voice',
        'models': [{'id': 'grok-voice-latest', 'name': 'Grok Voice'}],
        'voices': ['eve', 'ara', 'rex', 'sal', 'leo'],
        'sampleRate': 24000,
    },
    'qwen': {
        'name': 'Alibaba Qwen Realtime',
        'models': [{'id': 'qwen3.8-omni-flash-realtime', 'name': 'Qwen3.8 Omni Flash Realtime'}],
        'voices': ['Sohee', 'Tina', 'Cindy', 'Raymond'],
        'sampleRate': 48000,
    },
}


def settings() -> dict:
    from hermes_cli.config import load_config
    return (load_config().get('plugins', {}).get('entries', {}).get('hermes-live', {}).get('settings') or {})


KEY_NAMES = {
    'gemini': ['HERMES_LIVE_GEMINI_API_KEY', 'GEMINI_API_KEY_FOR_LIVE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    'grok': ['HERMES_LIVE_GROK_API_KEY', 'XAI_API_KEY'],
    'qwen': ['HERMES_LIVE_QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
}


def resolve_key(provider: str, config: dict) -> str:
    from agent.secret_scope import get_secret
    override = str(config.get(f'{provider}_key_env') or '').strip()
    if override:
        if not re.fullmatch(r'[A-Z_][A-Z0-9_]*', override):
            raise ValueError('HL_ERROR:errKeyName')
        # Explicit bindings never fall back to another account's credential.
        return (get_secret(override) or '').strip()
    names = KEY_NAMES.get(provider, [])
    if not names:
        return ''
    primary = (get_secret(names[0]) or '').strip()
    if primary:
        return primary
    if config.get(f'{provider}_bws_secret_id'):
        raise ValueError('HL_ERROR:errMigration')
    for name in names[1:]:
        value = get_secret(name)
        if value:
            return value.strip()
    return ''


def provider_status(provider: str, config: dict) -> dict:
    if provider == 'codex':
        return {'id': provider, **PROVIDERS[provider], **codex.readiness()}
    try:
        if provider == 'qwen':
            qwen_endpoint(config)
        key = resolve_key(provider, config)
        ready = bool(key and key != 'PENDING')
        reason = None if ready else 'HL_ERROR:errKey'
    except ValueError as exc:
        ready = False
        message = str(exc)
        safe = {'HL_ERROR:errKeyName', 'HL_ERROR:errMigration',
                'Qwen Workspace ID를 설정하세요 (ws-로 시작하는 ID).',
                'Qwen 지역은 singapore 또는 beijing이어야 합니다.'}
        reason = message if message in safe else 'HL_ERROR:errCredentialScope'
    except Exception:
        ready, reason = False, 'HL_ERROR:errCredentialScope'
    return {'id': provider, **PROVIDERS[provider], 'available': ready, 'reason': reason,
            'authState': 'configured' if ready else 'setup_required'}


def validate_selection(provider: str, model: str, voice: str) -> dict:
    entry = PROVIDERS.get(provider)
    if not entry or model not in [m['id'] for m in entry['models']] or voice not in entry['voices']:
        raise ValueError('지원하지 않는 제공자·라이브 모델·목소리 조합입니다.')
    return entry


def provider_error(status: int) -> str:
    kind = {401: 'API 키 인증 실패', 403: 'API 접근 권한 없음', 404: '모델 또는 API를 찾을 수 없음',
            429: 'API 한도 또는 크레딧 확인 필요'}.get(status, '라이브 API 요청 실패')
    return f'{kind} (HTTP {status}).'


def gemini_token_request(model: str) -> dict:
    now = datetime.now(timezone.utc)
    stamp = lambda dt: dt.isoformat().replace('+00:00', 'Z')
    return {'uses': 1, 'expireTime': stamp(now + timedelta(minutes=30)),
            'newSessionExpireTime': stamp(now + timedelta(minutes=1)),
            'fieldMask': 'model', 'bidiGenerateContentSetup': {'model': f'models/{model}'}}


class ConnectRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: str
    model: str
    voice: str


@router.get('/catalog')
def catalog(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    config = settings()
    return {'providers': [provider_status(name, config) for name in PROVIDERS], 'backend': socket.gethostname()}


class ReadinessRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: str


@router.post('/readiness')
def readiness(body: ReadinessRequest, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    if body.provider not in PROVIDERS:
        raise HTTPException(400, 'HL_ERROR:errRequest')
    return {'provider': provider_status(body.provider, settings()), 'backend': socket.gethostname()}


@router.post('/connect')
def connect(body: ConnectRequest, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    if body.provider in ('codex', 'qwen'):
        raise HTTPException(400, '이 제공자는 WebRTC 연결 경로를 사용하세요.')
    try:
        entry = validate_selection(body.provider, body.model, body.voice)
        key = resolve_key(body.provider, settings())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    if not key or key == 'PENDING':
        raise HTTPException(503, '제공자 API 키가 아직 설정되지 않았습니다.')
    if body.provider == 'gemini':
        url = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'
        headers = {'x-goog-api-key': key}
        payload = gemini_token_request(body.model)
    else:
        url = 'https://api.x.ai/v1/realtime/client_secrets'
        headers = {'Authorization': f'Bearer {key}'}
        payload = {'expires_after': {'seconds': 300}}
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as client:
            result = client.post(url, headers=headers, json=payload)
        if result.status_code != 200:
            raise HTTPException(502, provider_error(result.status_code))
        data = result.json()
        token = data.get('name') if body.provider == 'gemini' else data.get('value')
        if not isinstance(token, str) or not token:
            raise HTTPException(502, '단기 연결 토큰을 받지 못했습니다.')
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, '라이브 API 연결에 실패했습니다. 네트워크와 API 설정을 확인하세요.') from None
    return {'provider': body.provider, 'model': body.model, 'voice': body.voice,
            'token': token, 'sampleRate': entry['sampleRate']}


def qwen_endpoint(config: dict) -> str:
    workspace = str(config.get('qwen_workspace_id') or '').strip()
    if not re.fullmatch(r'ws-[a-z0-9]{1,50}', workspace):
        raise ValueError('Qwen Workspace ID를 설정하세요 (ws-로 시작하는 ID).')
    region = config.get('qwen_region') or 'singapore'
    domains = {'singapore': 'ap-southeast-1', 'beijing': 'cn-beijing'}
    if region not in domains:
        raise ValueError('Qwen 지역은 singapore 또는 beijing이어야 합니다.')
    # Build an allowlisted official host; never accept an arbitrary signaling URL.
    return f'https://{workspace}.{domains[region]}.maas.aliyuncs.com/api/v1/webrtc/realtime'


class QwenSessionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: str
    voice: str
    offer: str = Field(min_length=16, max_length=100000)


@router.post('/qwen/session')
def qwen_session(body: QwenSessionRequest, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        validate_selection('qwen', body.model, body.voice)
        if not body.offer.startswith('v=0'):
            raise ValueError('WebRTC 연결 정보가 올바르지 않습니다.')
        config = settings()
        url = qwen_endpoint(config)
        key = resolve_key('qwen', config)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    if not key or key == 'PENDING':
        raise HTTPException(503, 'Qwen API 키를 먼저 설정하세요.')
    try:
        with httpx.Client(timeout=30, follow_redirects=False) as client:
            result = client.post(url, params={'model': body.model},
                                 headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/sdp'},
                                 content=body.offer)
        if result.status_code != 200:
            raise HTTPException(502, provider_error(result.status_code))
        answer = result.text
        if len(answer) > 100000 or not answer.startswith('v=0'):
            raise HTTPException(502, 'Qwen WebRTC 연결 응답이 올바르지 않습니다.')
    except httpx.HTTPError:
        raise HTTPException(502, 'Qwen 음성 서버에 연결하지 못했습니다.') from None
    return {'answer': answer, 'region': config.get('qwen_region') or 'singapore'}


class CodexSessionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    callId: UUID
    model: str
    voice: str
    offer: str = Field(min_length=16, max_length=100000)


class CodexCallRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    callId: UUID


@router.post('/codex/prewarm')
def codex_prewarm(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    wake_config()  # Only explicitly configured local hands-free profiles.
    return codex.sessions.prewarm()


@router.post('/codex/session')
def codex_session(body: CodexSessionRequest, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        validate_selection('codex', body.model, body.voice)
        if not body.offer.startswith('v=0'):
            raise ValueError('WebRTC 연결 정보가 올바르지 않습니다.')
        return codex.sessions.start(str(body.callId), body.voice, body.offer, body.model)
    except (ValueError, codex.BrokerError) as exc:
        raise HTTPException(400, str(exc)) from None
    except Exception:
        raise HTTPException(502, 'Codex 음성 연결에 실패했습니다. CLI와 구독 상태를 확인하세요.') from None


@router.post('/codex/heartbeat')
def codex_heartbeat(body: CodexCallRequest):
    try:
        return codex.sessions.heartbeat(str(body.callId))
    except codex.BrokerError as exc:
        raise HTTPException(410, str(exc)) from None


@router.post('/codex/stop')
def codex_stop(body: CodexCallRequest):
    return codex.sessions.stop(str(body.callId))


@router.get('/codex/usage')
def codex_usage(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return codex.usage_snapshot()
    except Exception:
        # Never relay provider errors (which may include account identity or credentials).
        raise HTTPException(503, 'Codex 구독 사용량을 조회하지 못했습니다. 로그인 상태를 확인한 뒤 다시 시도하세요.') from None

# Shared across profile-scoped copies in the host multiplexer. The detector itself
# enforces machine-wide ownership; events never enter the built-in voice path.
_wake_name = '_hermes_live_wake_v1'
if _wake_name not in sys.modules:
    _wake_spec = importlib.util.spec_from_file_location(_wake_name, Path(__file__).with_name('wake_service.py'))
    _wake_module = importlib.util.module_from_spec(_wake_spec)
    sys.modules[_wake_name] = _wake_module
    _wake_spec.loader.exec_module(_wake_module)
wake = sys.modules[_wake_name]

_registry_spec = importlib.util.spec_from_file_location(__name__+'_wake_registry',Path(__file__).with_name('wake_registry.py'))
registry_module = importlib.util.module_from_spec(_registry_spec)
_registry_spec.loader.exec_module(registry_module)


_assets_spec = importlib.util.spec_from_file_location(__name__+'_assets',Path(__file__).with_name('wake_assets.py'))
assets_module = importlib.util.module_from_spec(_assets_spec)
_assets_spec.loader.exec_module(assets_module)


def setup_path():
    from hermes_constants import get_default_hermes_root
    return get_default_hermes_root()/'state/hermes-live/setup.json'


_voice_state_spec=importlib.util.spec_from_file_location(__name__+'_voice_state',Path(__file__).with_name('voice_state.py'))
voice_state=importlib.util.module_from_spec(_voice_state_spec)
_voice_state_spec.loader.exec_module(voice_state)


def voice_state_path():
    # Shared by every profile backend so external readers see one file.
    from hermes_constants import get_default_hermes_root
    return get_default_hermes_root()/voice_state.STATE_RELATIVE


def voice_token_path():
    from hermes_constants import get_default_hermes_root
    return get_default_hermes_root()/voice_state.TOKEN_RELATIVE


@router.post('/voice/state')
def report_voice_state(response: Response, payload: dict = Body(...)):
    response.headers['Cache-Control']='no-store'
    try:
        # Create the link token early so external controllers can read it before their first command.
        voice_state.ensure_token(voice_token_path())
        result=voice_state.write_report(voice_state_path(),payload,int(time.time()*1000))
    except ValueError:raise HTTPException(400,'Invalid voice state report') from None
    except OSError:raise HTTPException(503,'Could not write voice state') from None
    return {'written':result['written']}


@router.post('/voice/verify')
def verify_voice_token(response: Response, payload: dict = Body(...)):
    response.headers['Cache-Control']='no-store'
    if set(payload)!={'token'}:raise HTTPException(400,'Invalid voice token request')
    try:return {'ok':voice_state.verify_token(voice_token_path(),payload['token'])}
    except OSError:raise HTTPException(503,'Could not read voice token') from None


def wake_settings():
    # Only non-secret wake configuration is inherited from the local primary profile.
    from hermes_constants import get_default_hermes_root
    from hermes_cli.config import read_user_config_raw
    raw=read_user_config_raw(get_default_hermes_root()/'config.yaml')
    primary=raw.get('plugins',{}).get('entries',{}).get('hermes-live',{}).get('settings',{})
    return {**{k:v for k,v in primary.items() if k.startswith('wake_')},
            **{k:v for k,v in settings().items() if k.startswith('wake_')},
            **assets_module.read_json(setup_path()).get('wake',{})}


def bot_registry():
    cfg=wake_settings()
    return registry_module.registry({'target':cfg.get('wake_target',''),'phrase':cfg.get('wake_phrase','헤이 루미')})

class WakeBotEntry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    profile: str = Field(min_length=1,max_length=64)
    enabled: bool
    aliases: list[str] = Field(default_factory=list,max_length=3)

class WakeBotsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: str = Field(min_length=1,max_length=64)
    bots: list[WakeBotEntry] = Field(max_length=100)

@router.get('/wake/bots')
def wake_bots(response: Response):
    response.headers['Cache-Control']='no-store'
    return bot_registry().read()

@router.put('/wake/bots')
def save_wake_bots(body: WakeBotsRequest,response: Response):
    response.headers['Cache-Control']='no-store'
    try:
        return bot_registry().save(body.revision,[b.model_dump() for b in body.bots])
    except registry_module.RegistryConflict:
        raise HTTPException(409,'HL_ERROR:errWakeChanged') from None
    except registry_module.RegistryError:
        raise HTTPException(400,'HL_ERROR:errWakeRegistry') from None

class WakeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    owner: UUID
    action: str = Field(pattern=r'^(arm|heartbeat|claim|pause|resume|release)$')
    eventId: UUID | None = None


def wake_config(*, preparing=False):
    cfg = wake_settings()
    if not preparing and not cfg.get('wake_enabled', False):
        raise HTTPException(403, 'Hands-free calling is not configured for this profile')
    device = str(cfg.get('wake_input_device','')).strip()
    if not device:
        raise HTTPException(400,'Hands-free microphone is required')
    targets=bot_registry().read()['targets']
    provider=cfg.get('wake_provider','whisper')
    first=targets[0] if targets else {'target':'','phrases':[]}
    result={'target':first['target'],'phrase':', '.join(t['phrases'][0] for t in targets),
            'targets':targets,'input_device':device[:200],'provider':provider}
    if provider == 'whisper':
        # New installs use the bundled engine. Explicit working legacy paths are preserved.
        legacy = not cfg.get('wake_managed',False) and all(str(cfg.get('wake_whisper_'+k) or '').strip() for k in ('node','module','models','engine'))
        if not legacy:
            try: result['whisper_native'] = assets_module.assets().resolve(cfg)
            except assets_module.SetupError as exc: raise HTTPException(503,'HL_SETUP:'+str(exc)) from None
        else:
            for key in ('node','module','models','engine'):
                path = Path(str(cfg.get('wake_whisper_'+key,'')).strip()).expanduser()
                if not path.is_absolute() or not path.exists():
                    raise HTTPException(503, 'HL_SETUP:legacyMissing')
                result['whisper_'+key] = str(path)
            model = str(cfg.get('wake_whisper_model','small'))
            if model not in assets_module.MODELS or not (Path(result['whisper_models'])/f'ggml-{model}.bin').is_file():
                raise HTTPException(503, 'HL_SETUP:modelMissing')
            result['whisper_model'] = model
        return result
    if provider == 'sherpa' and len(targets)>1:
        raise HTTPException(400,'Multiple bot names require the local Whisper provider')
    if provider != 'sherpa':
        raise HTTPException(400, 'Unsupported local wake provider')
    from hermes_constants import get_default_hermes_root
    model_dir = get_default_hermes_root() / 'cache/wakewords/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
    if not (model_dir / 'tokens.txt').is_file():
        raise HTTPException(503, 'Install the local sherpa wake model before enabling hands-free calling')
    return {**result,'model_dir':str(model_dir)}


@router.get('/wake/config')
def get_wake_config(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return wake_config()


@router.post('/wake/control')
def wake_control(payload: WakeRequest, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    cfg = {} if payload.action=='release' else wake_config()
    try:
        return wake.runtime().control(str(payload.owner),payload.action,cfg,str(payload.eventId) if payload.eventId else None)
    except wake.WakeConflict as exc:
        reasons={'Wake lease expired':'lease_expired','Another window owns the microphone':'foreign_owner','Stale wake event':'stale_event','Bot selection changed before claim':'selection_changed','Wake microphone disconnected':'mic_disconnected'}
        diag.journal().emit('wake.error',{'action':payload.action,'owner':str(payload.owner),'reason':reasons.get(str(exc),'wake_conflict')})
        raise HTTPException(409, 'Hands-free listener is busy, expired or disconnected') from None
    except Exception:
        diag.journal().emit('wake.error',{'action':payload.action,'reason':'microphone_or_dependencies'})
        raise HTTPException(503, 'Could not open the local wake microphone; check the device and wake dependencies') from None


@router.get('/wake/status')
def get_wake_status(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    wake_config()
    return wake.runtime().diagnostics()


_prewarm_spec = importlib.util.spec_from_file_location(__name__+'_prewarm',Path(__file__).with_name('wake_prewarm.py'))
prewarm = importlib.util.module_from_spec(_prewarm_spec)
_prewarm_spec.loader.exec_module(prewarm)


@router.post('/wake/prewarm')
def wake_prewarm(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    from hermes_cli.profiles import list_profiles
    selected={target['target'] for target in wake_config()['targets']}
    homes=[profile.path for profile in list_profiles(lazy_skill_count=True) if profile.name in selected]
    prewarm.targets.refresh(homes)
    return {'scheduled':len(homes)}

# Setup remains readable before wake is enabled. The host scopes these routes to
# the selected backend/profile; the Desktop only offers wake setup on local routes.
def setup_devices():
    try:
        import sounddevice as sd
        import numpy
        names=[d['name'] for d in sd.query_devices() if d['max_input_channels']>0]
        return {'devices':list(dict.fromkeys(names)), 'duplicates':[n for n in set(names) if names.count(n)>1], 'error':''}
    except ImportError: return {'devices':[],'duplicates':[],'error':'audioDependencies'}
    except Exception: return {'devices':[],'duplicates':[],'error':'audioDevices'}

@router.get('/setup')
def get_setup(response: Response):
    response.headers['Cache-Control']='no-store'
    cfg=wake_settings()
    try: model=assets_module.assets().status(cfg)
    except assets_module.SetupError as exc:
        model={'error':str(exc),'supported':assets_module.assets().supported,
               'engine':bool(assets_module.assets().engine()),'installed':False,'prepared':False,
               'model':str(cfg.get('wake_whisper_model') or 'small'),'bytes':0,'source':'managed','progress':{}}
    return {'assets':model,'audio':setup_devices(),'device':cfg.get('wake_input_device',''),
            'enabled':bool(cfg.get('wake_enabled',False)), 'legacy':all(cfg.get('wake_whisper_'+k) for k in ('node','module','models','engine')) and not cfg.get('wake_managed'),
            'configured':assets_module.read_json(setup_path()).get('configured',False)}

class SetupRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    device: str = Field(min_length=1,max_length=200)

@router.put('/setup')
def save_setup(body:SetupRequest,response:Response):
    response.headers['Cache-Control']='no-store'
    devices=setup_devices()
    if body.device not in devices['devices'] or body.device in devices['duplicates']:
        raise HTTPException(400,'HL_SETUP:audioDevices')
    try: assets_module.assets().resolve(wake_settings())
    except assets_module.SetupError as exc: raise HTTPException(503,'HL_SETUP:'+str(exc)) from None
    # Preserve unrelated settings, models, bot opt-ins, and profile voice choices.
    value=assets_module.read_json(setup_path())
    value['wake']={'wake_enabled':True,'wake_provider':'whisper','wake_input_device':body.device, 'wake_managed':True}
    value['configured']=True
    assets_module.atomic_json(setup_path(),value)
    return get_setup(response)

@router.post('/setup/model')
def prepare_model(response:Response):
    response.headers['Cache-Control']='no-store'
    try:return assets_module.assets().start(wake_settings())
    except assets_module.SetupError as exc:raise HTTPException(503,'HL_SETUP:'+str(exc)) from None

@router.delete('/setup/model')
def cancel_model(response:Response):
    response.headers['Cache-Control']='no-store'
    assets_module.assets().cancel()
    return {'cancelled':True}

@router.post('/setup/test')
def setup_test(body:WakeRequest,response:Response):
    response.headers['Cache-Control']='no-store'
    if body.action not in ('arm','heartbeat','release'):raise HTTPException(400,'HL_SETUP:testAction')
    try:
        cfg={} if body.action=='release' else wake_config(preparing=True)
        status=wake.runtime().control(str(body.owner),body.action,cfg)
        return {**status, 'diagnostics':wake.runtime().diagnostics()}
    except wake.WakeConflict:raise HTTPException(409,'HL_SETUP:microphoneBusy') from None
    except HTTPException:raise
    except Exception:raise HTTPException(503,'HL_SETUP:microphoneFailed') from None

@router.get('/setup/login')
def setup_login_status(response:Response):
    response.headers['Cache-Control']='no-store'
    return codex.login_flow.status()

@router.post('/setup/login')
def setup_login_start(response:Response):
    response.headers['Cache-Control']='no-store'
    if not codex.binary():raise HTTPException(503,'HL_ERROR:errCodexMissing')
    if codex.sessions.calls:raise HTTPException(409,'HL_ERROR:errBusy')
    return codex.login_flow.start()

@router.delete('/setup/login')
def setup_login_cancel(response:Response):
    response.headers['Cache-Control']='no-store'
    return codex.login_flow.cancel()


class DiagnosticEvent(BaseModel):
    model_config=ConfigDict(extra='forbid')
    event: str = Field(max_length=64)
    fields: dict = Field(default_factory=dict,max_length=30)
    at: float | None = None
    text: str | None = Field(default=None,max_length=500)
    detailId: str | None = Field(default=None,max_length=80)

class DiagnosticBatch(BaseModel):
    model_config=ConfigDict(extra='forbid')
    events: list[DiagnosticEvent] = Field(max_length=50)

class DiagnosticConsent(BaseModel):
    model_config=ConfigDict(extra='forbid')
    seconds: int = Field(ge=0,le=300)

class DiagnosticControl(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    recording: bool

def diagnostic_status(response:Response):
    response.headers['Cache-Control']='no-store'
    return diag.journal().status()

def diagnostic_control(body:DiagnosticControl,response:Response):
    response.headers['Cache-Control']='no-store'
    return diag.journal().control(body.recording)

def diagnostic_tail(response:Response,after:str=Query(default='',max_length=80),limit:int=Query(default=200,ge=1,le=500),include_text:bool=False):
    response.headers['Cache-Control']='no-store'
    return diag.journal().snapshot(limit=limit,after=after,include_text=include_text)

def diagnostic_report(response:Response,include_text:bool=False):
    response.headers['Cache-Control']='no-store'
    return diag.journal().snapshot(include_text=include_text)

def diagnostic_events(body:DiagnosticBatch,response:Response):
    response.headers['Cache-Control']='no-store'
    journal=diag.journal()
    accepted=sum(bool(journal.emit(e.event,e.fields,text=e.text,at=e.at,detail_id=e.detailId)) for e in body.events)
    return {'accepted':accepted,'ignored':len(body.events)-accepted,'recording':journal.recording_state()['enabled'],'writeError':journal.write_error}

def diagnostic_detail(body:DiagnosticConsent,response:Response):
    response.headers['Cache-Control']='no-store'
    try:diag.journal().detail(body.seconds)
    except ValueError:raise HTTPException(409,detail='recording_disabled')
    return diag.journal().snapshot(include_text=False)

# Never mount diagnostic APIs in ordinary distribution installs.
if diag.enabled():
    router.add_api_route('/diagnostics/status',diagnostic_status,methods=['GET'])
    router.add_api_route('/diagnostics/control',diagnostic_control,methods=['POST'])
    router.add_api_route('/diagnostics/tail',diagnostic_tail,methods=['GET'])
    router.add_api_route('/diagnostics',diagnostic_report,methods=['GET'])
    router.add_api_route('/diagnostics/events',diagnostic_events,methods=['POST'])
    router.add_api_route('/diagnostics/detail',diagnostic_detail,methods=['POST'])
