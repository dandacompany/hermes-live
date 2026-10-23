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
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from uuid import UUID

_spec = importlib.util.spec_from_file_location(__name__ + '_codex', Path(__file__).with_name('codex_broker.py'))
codex = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = codex
_spec.loader.exec_module(codex)

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
