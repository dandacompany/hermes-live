"""The pre-ctx.files Desktop mailbox. Only the three Switchboard v2 filenames are reachable."""
import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import sys
import tempfile

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

router = APIRouter()
PAIRING_FILE = 'hermes-live-switchboard.key'
CONNECTOR_FILE = 'hermes-live-connector.key'
NONCE = r'[0-9a-f]{32}'
INSTANCE = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
LIMIT = 4096
CONNECTION = r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
PROFILE = r'[a-z0-9][a-z0-9_-]{0,63}'
ACTIONS = {'start', 'stop', 'toggle', 'open'}
REASONS = {'bad_request', 'bad_token', 'auth_unavailable', 'duplicate', 'busy', 'transitioning',
           'paused', 'already_on', 'already_off', 'wrong_bot', 'unsupported_sdk', 'unknown_connection',
           'unknown_profile', 'route_unavailable', 'open_failed', 'scope_changed', 'switch_failed',
           'start_failed', 'stop_failed'}
LOOPBACK = {'127.0.0.1', '::1', 'localhost'}


def _user_data():
    # Use the actual shell directory for isolated launches (including a suffixed userData).
    ready = os.environ.get('HERMES_DESKTOP_READY_FILE')
    override = os.environ.get('HERMES_DESKTOP_USER_DATA_DIR')
    if ready and Path(ready).parent.name == 'backend-ready':
        root = Path(ready).parent.parent
    elif override:
        root = Path(override)
    else:
        base = Path.home()
        if sys.platform == 'darwin':
            base = base/'Library/Application Support'
        elif os.name == 'nt':
            base = Path(os.environ.get('APPDATA') or base/'AppData/Roaming')
        else:
            base = Path(os.environ.get('XDG_CONFIG_HOME') or base/'.config')
        name = (os.environ.get('HERMES_DESKTOP_APP_NAME') or 'Hermes')+os.environ.get('HERMES_DATA_DIR_SUFFIX','')
        root = base / name
    return root


def _owned(directory):
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode)
            or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
        raise OSError('Unsafe mailbox directory')
    if os.name == 'nt':
        import win32api, win32security, win32con
        import ntsecuritycon
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            sid = win32security.GetTokenInformation(token,win32security.TokenUser)[0]
        finally:
            token.Close()
        security = win32security.GetNamedSecurityInfo(str(directory),win32security.SE_FILE_OBJECT,
                          win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION)
        dacl = security.GetSecurityDescriptorDacl()
        if security.GetSecurityDescriptorOwner() != sid or dacl is None:
            raise OSError('Unsafe mailbox owner or ACL')
        # Administrators and SYSTEM already control this account. Reject other principals with
        # any effective write/delete grant, including inherited grants on a shared directory.
        trusted = {win32security.ConvertSidToStringSid(sid), 'S-1-5-18', 'S-1-5-32-544'}
        writes = (ntsecuritycon.FILE_WRITE_DATA | ntsecuritycon.FILE_APPEND_DATA | ntsecuritycon.FILE_DELETE_CHILD
                  | ntsecuritycon.WRITE_DAC | ntsecuritycon.WRITE_OWNER | ntsecuritycon.DELETE
                  | ntsecuritycon.GENERIC_WRITE | ntsecuritycon.GENERIC_ALL)
        for idx in range(dacl.GetAceCount()):
            ace = dacl.GetAce(idx)
            (kind, flags), mask = ace[:2]
            if flags & 0x08 or kind == win32security.ACCESS_DENIED_ACE_TYPE:  # INHERIT_ONLY_ACE
                continue
            if mask & writes and win32security.ConvertSidToStringSid(ace[-1]) not in trusted:
                raise OSError('Shared mailbox directory is writable by another principal')
    elif info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise OSError('Unsafe mailbox directory owner or permissions')


def _directory(root=None):
    root = root if root is not None else _user_data()
    if not root.is_absolute() or not root.is_dir() or root.resolve() != root:
        raise OSError('Desktop userData unavailable')
    folder = root
    _owned(folder)
    for name in ('plugin-files', 'data', 'hermes-live'):
        folder = folder / name
        folder.mkdir(mode=0o700, exist_ok=True)
        _owned(folder)
    return folder


def _read(path, private=False):
    if os.name == 'nt' and private:
        from hermes_cli.windows_ssh_runtime import _read_shared
        data = _read_shared(path, LIMIT + 1, share=1)
        if data is None:
            raise FileNotFoundError()
    else:
        if path.resolve() != path.absolute():
            raise OSError('Unsafe mailbox file')
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
                raise ValueError('Invalid file')
            if os.name != 'nt' and (info.st_uid != os.getuid() or (private and info.st_mode & 0o077)):
                raise OSError('Unsafe mailbox file')
            data = source.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Oversized file')
    return data


def _publish(path, data, exclusive):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.live-')
    try:
        if os.name == 'nt':
            os.close(fd)
            from hermes_cli.windows_ssh_runtime import write_private_file
            write_private_file(Path(tmp), data)
        else:
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
        # Linking a fully written sibling gives O_EXCL semantics without ever publishing partial JSON.
        if exclusive:
            os.link(tmp, path)
        else:
            os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _validate(name, text, exclusive):
    record = json.loads(text)
    if not isinstance(record, dict) or type(record.get('v')) is not int or record['v'] != 2:
        raise ValueError('Invalid version')
    instance = record.get('instance')
    if not _matches(INSTANCE, instance):
        raise ValueError('Invalid instance')
    target = _matches(CONNECTION, record.get('connectionId')) and _matches(PROFILE, record.get('profile'))
    if name.startswith('state-'):
        valid = (set(record) == {'v','instance','updatedAt','status','connectionId','profile'}
                 and name == f'state-{instance}.json' and type(record['updatedAt']) is int
                 and (record['status'] in ('connecting','in_call') and target
                      or record['status'] in ('off','unknown') and record['connectionId'] is None and record['profile'] is None))
    else:
        common = {'v','instance','action','connectionId','profile'}
        if not target or record.get('action') not in ACTIONS:
            raise ValueError('Invalid target')
        if name.startswith('request-'):
            valid = (set(record) == common | {'expiresAt','sha256'} and type(record['expiresAt']) is int
                     and _matches(r'[0-9a-f]{64}', record['sha256']))
        else:
            valid = (set(record) == common | {'nonce','at','outcome','reason'} and type(record['at']) is int
                     and name == f"result-{record['nonce']}.json" and (record['outcome']=='pending') == exclusive
                     and (record['outcome'] in ('pending','accepted') and record['reason'] is None
                          or record['outcome'] in ('failed','rejected') and record['reason'] in REASONS))
    if not valid:
        raise ValueError('Invalid mailbox record')


def operate(directory, packet):
    try:
        if packet == {'op': 'verify'}:
            return {'ok': True}
        name = packet['path']
        if packet.get('op') == 'read' and re.fullmatch('request-' + NONCE + r'\.json', name):
            text = _read(directory/name).decode()
            _validate(name, text, False)
            return {'ok': True, 'text': text}
        exclusive = packet.get('exclusive')
        state = re.fullmatch('state-' + INSTANCE + r'\.json', name)
        result = re.fullmatch('result-' + NONCE + r'\.json', name)
        if (packet.get('op') != 'write' or not isinstance(exclusive, bool)
                or not (result or state and not exclusive)):
            raise ValueError('Invalid operation')
        data = packet['text'].encode()
        if len(data) > LIMIT:
            raise ValueError('Invalid record')
        _validate(name, packet['text'], exclusive)
        _publish(directory/name, data, exclusive)
        return {'ok': True}
    except FileExistsError:
        return {'ok': False, 'error': 'exists'}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {'ok': False, 'error': 'unavailable'}


def _local(request):
    # Neither an authenticated remote dashboard nor a reverse proxy represents this Desktop user.
    return (os.environ.get('HERMES_DESKTOP') == '1' and bool(os.environ.get('HERMES_PARENT_PID'))
            and request.client is not None and request.client.host in LOOPBACK
            and request.url.hostname in LOOPBACK and getattr(request.app.state, 'bound_host', '127.0.0.1') in LOOPBACK
            and not getattr(request.app.state, 'auth_required', False)
            and not any(h.lower().startswith(('forwarded', 'x-forwarded-', 'cf-')) for h in request.headers))


@router.post('/control-mailbox/prepare')
def prepare(request: Request):
    if not _local(request):
        raise HTTPException(403)
    try:
        path = _directory() / PAIRING_FILE
        try:
            _publish(path, secrets.token_hex(32).encode(), True)
        except FileExistsError:
            pass
        if not re.fullmatch(b'[0-9a-f]{64}', _read(path, private=True)):
            raise ValueError('Invalid pairing file')
        return {'file': str(path)}
    except (ValueError, OSError):
        raise HTTPException(409, 'Local pairing file unavailable') from None


@router.websocket('/control-mailbox')
async def exchange(ws: WebSocket):
    if not _local(ws) or ws.headers.get('origin') not in ('null', 'file://', 'app://hermes'):
        await ws.close(code=1008)
        return
    try:
        # HTTP middleware does not cover WebSockets. Honor current enablement after a live disable.
        from hermes_cli.plugins_cmd import _get_enabled_set, _get_disabled_set
        if 'hermes-live' not in _get_enabled_set() or 'hermes-live' in _get_disabled_set():
            await ws.close(code=1008)
            return
        folder = _directory()
        key = _read(folder / PAIRING_FILE, private=True)
        if not re.fullmatch(b'[0-9a-f]{64}', key):
            raise ValueError('Invalid pairing file')
        await _exchange(ws,folder,bytes.fromhex(key.decode('ascii')))
    except WebSocketDisconnect:
        pass
    except Exception:
        # Neither credentials, ticket data nor unauthenticated frames belong in exception logs.
        await ws.close(code=1008)



async def _exchange(ws, folder, key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    cipher = AESGCM(key)
    await ws.accept()
    challenge = secrets.token_bytes(16)
    await ws.send_bytes(challenge)
    frame = await asyncio.wait_for(ws.receive_bytes(), timeout=5)
    if len(frame) < 28 or len(frame) > LIMIT*2:
        raise ValueError('Invalid frame')
    iv, encrypted = frame[:12], frame[12:]
    message = cipher.decrypt(iv, encrypted, b'hermes-live/request'+challenge)
    result = operate(folder, json.loads(message))
    # Bind the response to this unique client request, including against a replaying server.
    out_iv = secrets.token_bytes(12)
    await ws.send_bytes(out_iv+cipher.encrypt(out_iv,json.dumps(result).encode(),b'hermes-live/result'+challenge+iv))
    await ws.close()


def is_admin():
    if os.name == 'nt':
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    return os.geteuid() == 0 or os.geteuid() != os.getuid()


def run_connector(root):
    """Optional local foreground transport for a Desktop without an in-process plugin backend."""
    if is_admin():
        raise ValueError('Use your ordinary Desktop account, without administrator privileges.')
    from fastapi import FastAPI
    import uvicorn
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    root = root if root is not None else _user_data()
    folder = _directory(root)
    path = folder/CONNECTOR_FILE
    try:
        grant = json.loads(_read(path, private=True))
        if (not isinstance(grant,dict) or set(grant) != {'v','key','port'} or grant['v'] != 1
                or not _matches(r'[0-9a-f]{64}',grant['key']) or type(grant['port']) is not int
                or not 1024 <= grant['port'] <= 65535):
            raise ValueError('Invalid existing connector grant')
        port = grant['port']
    except FileNotFoundError:
        grant = None
        port = 0
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name=='nt':
            sock.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        else:
            sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        # Listen before publishing the grant, so another connector cannot reuse its port.
        sock.bind(('127.0.0.1',port))
        sock.listen(16)
        if grant is None:
            grant = {'v':1,'key':AESGCM.generate_key(256).hex(),'port':sock.getsockname()[1]}
            _publish(path,json.dumps(grant).encode(),True)
        key = bytes.fromhex(grant['key'])
        app = FastAPI(openapi_url=None,docs_url=None,redoc_url=None)

        @app.websocket('/api/plugins/hermes-live/control-mailbox')
        async def connector(ws: WebSocket):
            if (not ws.client or ws.client.host != '127.0.0.1' or ws.url.hostname != '127.0.0.1'
                    or ws.headers.get('origin') not in ('null','file://','app://hermes')):
                await ws.close(code=1008)
                return
            try:
                await _exchange(ws,_directory(root),key)
            except WebSocketDisconnect:
                pass
            except Exception:
                await ws.close(code=1008)

        config = uvicorn.Config(app, host='127.0.0.1', port=sock.getsockname()[1], proxy_headers=False,
                                access_log=False, ws_max_size=LIMIT*2, limit_concurrency=16, log_level='warning')
        print(f'Switchboard pairing file: {path}', flush=True)
        uvicorn.Server(config).run(sockets=[sock])


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Serve the same-user Switchboard mailbox until Ctrl+C.')
    parser.add_argument('--user-data',type=Path,help='Existing Hermes Desktop userData directory')
    try:
        run_connector(parser.parse_args().user_data)
    except (OSError,ValueError,ImportError) as error:
        parser.exit(1,f'Cannot start Switchboard connector: {error}\n')
