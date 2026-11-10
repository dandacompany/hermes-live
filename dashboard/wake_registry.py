"""Shared local bot opt-ins; display names are resolved afresh, never used as routing IDs."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

class RegistryError(ValueError):pass
class RegistryConflict(RegistryError):pass

def normalized(value):
    return re.sub(r'[\s,，.!。！]','',unicodedata.normalize('NFKC',value).lower())

def valid_name(value):
    return (isinstance(value,str) and 0<len(value.strip())<=40 and
            all(c.isalnum() or c in ' -_' for c in value.strip()) and bool(normalized(value)))

GREETINGS=('Hey','헤이')
MAX_GREETING=10
LEGACY_GREETINGS=('안녕',)  # stripped from old single-target phrases only; never offered
HANGUL=re.compile(r'[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\uffa0-\uffdf]')

def valid_greeting(value):
    """The trimmed greeting, or None. Commas would split the joined phrase list; a greeting that normalizes away would let the bare name wake."""
    value=value.strip() if isinstance(value,str) else ''
    return value if (0<len(value)<=MAX_GREETING and bool(normalized(value)) and
                     not any(c in ',，' or unicodedata.category(c)=='Cc' for c in value)) else None

def selected_greeting(value):
    return valid_greeting(value) or GREETINGS[0]

def greeting_order(value):
    first=selected_greeting(value)
    return tuple(g+' ' for g in (first,*(g for g in GREETINGS if g!=first)))

def greeting_language(value):
    # Whisper language: Korean when the greeting has any Hangul syllable or jamo, else English. No auto-detect.
    return 'ko' if HANGUL.search(selected_greeting(value)) else 'en'

def greeting_view(value):
    return {'greeting':selected_greeting(value),'greetings':list(GREETINGS),'greeting_max':MAX_GREETING}

def wake_name(phrase):
    """Name of a single-target phrase. A custom greeting is unknown here, so it stays part of the name."""
    for g in (*GREETINGS,*LEGACY_GREETINGS):phrase=phrase.removeprefix(g+' ')
    return phrase.strip()

class WakeRegistry:
    def __init__(self, path, roster, legacy):
        self.path,self.roster,self.legacy=Path(path),roster,legacy

    @contextmanager
    def locked(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with open(self.path.with_suffix('.lock'),'a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            yield

    def _load(self):
        if not self.path.exists():
            target=self.legacy.get('target','')
            return {'version':1,'serial':0,'entries':{target:{'enabled':True,'aliases':['Lumi'] if target=='lumi' else []}} if target else {}}
        data=json.loads(self.path.read_text())
        if data.get('version')!=1 or not isinstance(data.get('entries'),dict):
            raise RegistryError('Invalid wake registry')
        return data

    def _view(self,data):
        rows=self.roster();bots=[];targets=[];errors=[];owners={}
        for row in rows:
            profile=row['profile'];entry=data['entries'].get(profile,{})
            name=str(row.get('display_name') or '').strip()
            aliases=entry.get('aliases',[])
            names=list(dict.fromkeys(([name] if name else [])+aliases))
            bot={**row,'enabled':bool(entry.get('enabled',False)),'aliases':aliases,'phrases':[prefix+n for prefix in greeting_order(self.legacy.get('greeting')) for n in names],'error':''}
            if bot['enabled']:
                if not names or not all(valid_name(n) for n in names):bot['error']='name'
                elif not bot.get('ready'):bot['error']='setup'
                else:
                    target={'target':profile,'display_name':name or aliases[0],'names':names,'phrases':bot['phrases']}
                    targets.append(target)
                    for phrase in target['phrases']:owners.setdefault(normalized(phrase),set()).add(profile)
            bots.append(bot)
        conflicts=set().union(*(profiles for profiles in owners.values() if len(profiles)>1)) if owners else set()
        for bot in bots:
            if bot['profile'] in conflicts:bot['error']='duplicate'
            if bot['error']:errors.append({'profile':bot['profile'],'reason':bot['error']})
        targets=[t for t in targets if t['target'] not in conflicts]
        material=json.dumps({'data':data,'roster':rows},ensure_ascii=False,sort_keys=True)
        # The selected greeting lets the settings preview a bot that has no saved name yet in the right language.
        return {'revision':hashlib.sha256(material.encode()).hexdigest()[:24],'bots':bots,'targets':targets,'errors':errors,
                **greeting_view(self.legacy.get('greeting'))}

    def read(self):
        with self.locked():return self._view(self._load())

    def save(self,revision,bots):
        with self.locked():
            data=self._load();before=self._view(data)
            if before['revision']!=revision:raise RegistryConflict('The bot list changed; refresh before saving')
            current={b['profile'] for b in before['bots']};entries={};seen=set()
            if len(bots)>100:raise RegistryError('Too many bots')
            for bot in bots:
                profile=bot.get('profile');aliases=bot.get('aliases',[]);enabled=bot.get('enabled',False)
                if profile not in current or profile in seen:raise RegistryError('Unknown or duplicate profile')
                if type(enabled) is not bool or not isinstance(aliases,list) or len(aliases)>3 or not all(valid_name(a) for a in aliases):raise RegistryError('Use up to three short names per bot')
                seen.add(profile);entries[profile]={'enabled':enabled,'aliases':list(dict.fromkeys(a.strip() for a in aliases))}
            updated={'version':1,'serial':data.get('serial',0)+1,'entries':entries}
            result=self._view(updated)
            if result['errors']:raise RegistryError('HL_ERROR:errWakeRegistry')
            fd,temp=tempfile.mkstemp(dir=self.path.parent,prefix='.wake-')
            try:
                with os.fdopen(fd,'w') as out:
                    json.dump(updated,out,ensure_ascii=False,indent=2);out.flush();os.fsync(out.fileno())
                os.replace(temp,self.path)
            finally:
                if os.path.exists(temp):os.unlink(temp)
            return result

def installed_roster():
    from hermes_cli.profiles import list_profiles
    from hermes_constants import get_default_hermes_root
    from hermes_cli.config import read_user_config_raw
    rows=[]
    for profile in list_profiles(lazy_skill_count=True):
        cfg=read_user_config_raw(profile.path/'config.yaml')
        plugins=cfg.get('plugins',{})
        enabled=plugins.get('enabled',[]) or [];disabled=plugins.get('disabled',[]) or []
        available=any((root/'plugins/hermes-live/dashboard/plugin_api.py').is_file() for root in (profile.path,get_default_hermes_root()))
        ready=available and 'hermes-live' in enabled and 'hermes-live' not in disabled
        rows.append({'profile':profile.name,'display_name':profile.bot_title or profile.display_name or '', 'ready':ready})
    return rows

def registry(legacy):
    from hermes_constants import get_default_hermes_root
    return WakeRegistry(get_default_hermes_root()/'state/hermes-live/wake-bots.json',installed_roster,legacy)
