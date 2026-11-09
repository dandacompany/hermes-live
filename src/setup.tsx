import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Button,host,type PluginContext} from '@hermes/plugin-sdk';
import {useLiveI18n} from './i18n-react.ts';
import {localizeError} from './i18n.ts';
import {setupCopy,setupError,type SetupKey} from './setup-copy.ts';
import {basicReady,preparingModel,setupSteps,type SetupState} from './setup-state.ts';
import {WakeSettings} from './wake-settings.tsx';
import {GenericWakeSettings} from './generic-wake-settings.tsx';
import {DeviceSettings} from './device-settings.tsx';
import {settingsHref} from './auth.ts';
import {FieldSelect,hint,divider} from './ui.tsx';
import {AudioEngine} from './audio.ts';
import {selectWakeMicrophone,type AudioDevices} from './devices.ts';
import {playWakeCue} from './wake-cue.ts';
import type {CatalogItem} from './types.ts';
import type {WakeTarget} from './wake.ts';
interface TestStatus {eventId:string|null;target:string|null;selection?:WakeTarget;diagnostics:{model_ready?:boolean;model_error?:string;peak?:number;segments?:number}}
interface Props {suspended?:boolean;registerStopTest?:(fn:()=>Promise<void>)=>()=>void;ctx:PluginContext;local:boolean;scopeKey:string;active:()=>boolean;hold:()=>Promise<()=>void>;standby:()=>Promise<boolean>;listening:()=>boolean;trial:(target:string)=>Promise<void>;stop:()=>void;subscribe:(fn:()=>void)=>()=>void;callState:()=>string;callSettings:()=>void}
export function Setup({suspended=false,registerStopTest,ctx,local,scopeKey,active,hold,standby,listening,trial,stop,subscribe,callState,callSettings}:Props){
 const {locale,t}=useLiveI18n(),c=setupCopy(locale);
 const saved=ctx.storage.get<{mode:'wake'|'call';step:number}>(`setup:${scopeKey}`,{mode:'wake',step:0});
 const [mode,setMode]=useState(saved.mode),[step,setStep]=useState(saved.step),[data,setData]=useState<SetupState|null>(null);
 const [auth,setAuth]=useState<CatalogItem|null>(null),[targets,setTargets]=useState<WakeTarget[]>([]),[target,setTarget]=useState('');
 // The optional generic phrase can stand in for a bot: listening works with the phrase alone.
 const [generic,setGeneric]=useState(false),[genericPhrase,setGenericPhrase]=useState('');
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[note,setNote]=useState(''),[device,setDevice]=useState(''),[level,setLevel]=useState(0),[testing,setTesting]=useState(false);
 const [login,setLogin]=useState<{state:string;url?:string}>({state:'idle'}),[devices,setDevices]=useState<AudioDevices>(ctx.storage.get('audio-devices',{input:'',output:''}));
 const [volume,setVolume]=useState(ctx.storage.get('wake-cue-volume',1));
 const [auto,setAuto]=useState(ctx.storage.get('hands-free-enabled',false));
 const alive=useRef(true),cancel=useRef<AbortController|null>(null),owner=useRef<string|null>(null),restore=useRef<(()=>void)|null>(null),polling=useRef(false),openedLogin=useRef(''),initial=useRef(true);
 const captureTask=useRef<Promise<void>|null>(null);
 useEffect(()=>registerStopTest?.(async()=>{cancel.current?.abort();await captureTask.current}),[registerStopTest]);
 useEffect(()=>{if(suspended)cancel.current?.abort()},[suspended]);
 const currentCall=useSyncExternalStore(subscribe,callState);
 const steps=setupSteps(mode),labels:SetupKey[]=['overview','bots','account','model','audio','test','done'];
 const safe=(fn:()=>void)=>{if(alive.current)fn()};
 const fail=(e:unknown)=>safe(()=>setError(setupError(locale,e)||localizeError(t,e)));
 const load=async()=>{
  if(!local)return;setLoading(true);setError('');
  try{const [value,bots,phrase]=await Promise.all([ctx.rest<SetupState>('/setup',{timeoutMs:30000}),ctx.rest<{targets:WakeTarget[]}>('/wake/bots'),ctx.rest<{enabled:boolean;supported:boolean;phrase:string}>('/setup/generic').catch(()=>null)]);
   safe(()=>{setData(value);setTargets(bots.targets);setGeneric(Boolean(phrase?.enabled&&phrase.supported));setGenericPhrase(phrase?.phrase??'');setDevice(d=>d||value.device||value.audio.devices[0]||'');setTarget(id=>bots.targets.some(b=>b.target===id)?id:bots.targets[0]?.target??'');
    if(initial.current){initial.current=false;if(basicReady(value)&&ctx.storage.get('hands-free-enabled',false))setStep(6)}
   });
  }catch(e){fail(e)}finally{safe(()=>setLoading(false))}
 };
 const checkAuth=async()=>{setLoading(true);try{const value=await ctx.rest<{provider:CatalogItem}>('/readiness',{method:'POST',body:{provider:'codex'},timeoutMs:30000});safe(()=>setAuth(value.provider))}catch(e){fail(e)}finally{safe(()=>setLoading(false))}};
 const release=async()=>{const id=owner.current;owner.current=null;try{if(id)await ctx.rest('/setup/test',{method:'POST',body:{owner:id,action:'release'}})}catch{}finally{restore.current?.();restore.current=null}};
 useEffect(()=>{alive.current=true;void load();void checkAuth();return()=>{alive.current=false;cancel.current?.abort();void release()}},[scopeKey,local]);
 useEffect(()=>{ctx.storage.set(`setup:${scopeKey}`,{mode,step});if(step===2)void checkAuth()},[step,mode]);
 useEffect(()=>{if(!local)return;const timer=setInterval(async()=>{
  if(polling.current)return;polling.current=true;
  try{
   if(preparingModel(data?.assets)){const value=await ctx.rest<SetupState>('/setup',{timeoutMs:30000});safe(()=>setData(value))}
   if(['starting','waiting'].includes(login.state)){
    const value=await ctx.rest<{state:string;url?:string}>('/setup/login');if(!alive.current)return;safe(()=>setLogin(value));
    if(value.url&&value.url!==openedLogin.current){openedLogin.current=value.url;await ctx.os?.openExternal(value.url)}
    if(value.state==='complete')await checkAuth();
   }
  }catch(e){fail(e)}finally{polling.current=false}
 },1200);return()=>clearInterval(timer)},[data?.assets.progress?.state,login.state,local]);
 const action=async(fn:()=>Promise<unknown>)=>{setError('');setNote('');setLoading(true);try{await fn()}catch(e){fail(e)}finally{safe(()=>setLoading(false))}};
 const model=()=>action(async()=>{await ctx.rest('/setup/model',{method:'POST',timeoutMs:30000});await load()});
 const saveDevice=()=>action(async()=>{
  const choice=selectWakeMicrophone(await navigator.mediaDevices.enumerateDevices(),device);
  if(!alive.current)return;
  const value=await ctx.rest<SetupState>('/setup',{method:'PUT',body:{device},timeoutMs:30000});
  if(!alive.current)return;const next={...devices,input:choice.deviceId};ctx.storage.set('audio-devices',next);setDevices(next);setData(value);setNote(c('setupSaved'));
 });
 const permission=()=>action(async()=>{const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});stream.getTracks().forEach(t=>t.stop());await load()});
 const capture=async(kind:'mic'|'wake')=>{
  if(active()){setError(c('busy'));return}
  const abort=new AbortController();cancel.current=abort;setTesting(true);setNote('');setError('');
  try{
   restore.current=await hold();if(abort.signal.aborted)return;
   if(kind==='mic'){
    const choice=selectWakeMicrophone(await navigator.mediaDevices.enumerateDevices(),device);
    const audio=new AudioEngine(()=>{},{...devices,input:choice.deviceId});let received=false;
    try{await audio.open(16000,abort.signal,(_data,rms)=>{if(rms>.005)received=true;safe(()=>setLevel(rms))});
     for(let i=0;i<80&&!received&&!abort.signal.aborted;i++)await new Promise(r=>setTimeout(r,100));
    }finally{audio.close()}
    if(abort.signal.aborted)return;
    if(!received){setNote(c('silent'));return}
   }
   const id=crypto.randomUUID();owner.current=id;let result=await ctx.rest<TestStatus>('/setup/test',{method:'POST',body:{owner:id,action:'arm'},timeoutMs:30000});
   const deadline=Date.now()+35000;
   while(!abort.signal.aborted&&Date.now()<deadline){
    const diag=result.diagnostics;
    if(diag.model_error)throw new Error('HL_SETUP:modelStartFailed');
    safe(()=>{setLevel(Math.min(1,(diag.peak??0)/12000));setNote(!diag.model_ready?c('preparing'):kind==='wake'&&diag.segments?c('notMatched'):c('silent'))});
    if(kind==='mic'&&diag.model_ready&&(diag.peak??0)>160){ctx.storage.set(`setup-mic:${device}`,true);safe(()=>setNote(c('micGood')));return}
    if(kind==='wake'&&result.eventId){ctx.storage.set(`setup-wake:${device}`,true);safe(()=>setNote(c('recognized')+': '+(result.selection?.display_name??result.target)));void playWakeCue(devices.output,volume);return}
    await new Promise(r=>setTimeout(r,500));if(abort.signal.aborted)break;
    result=await ctx.rest<TestStatus>('/setup/test',{method:'POST',body:{owner:id,action:'heartbeat'},timeoutMs:10000});
   }
   safe(()=>setNote(c('testExpired')));
  }catch(e){if(!abort.signal.aborted)fail(e)}finally{await release();cancel.current=null;safe(()=>{setTesting(false);setLevel(0)})}
 };
 const block=suspended||loading||testing||active()||!['idle','error'].includes(currentCall);
 const selected=targets.find(t=>t.target===target);
 const progress=data?.assets.progress;
 const errorText=progress?.error?setupError(locale,'HL_SETUP:'+progress.error):data?.assets.error?setupError(locale,'HL_SETUP:'+data.assets.error):null;
 const complete=mode==='call'?Boolean(devices):basicReady(data)&&(targets.length>0||generic)&&Boolean(auth?.available)&&Boolean(data?.legacy||data?.assets.prepared)&&Boolean(data?.legacy||ctx.storage.get(`setup-mic:${device}`,false));
 const canNext=step===1?targets.length>0||generic:step===2?Boolean(auth?.available)||mode==='call':step===3?Boolean(data?.assets.prepared):step===4?mode==='call'||Boolean(data?.device===device&&ctx.storage.get(`setup-mic:${device}`,false)):true;
 const next=()=>setStep(steps[Math.min(steps.indexOf(step)+1,steps.length-1)]!);
 const panel={display:'grid',gap:16} as const;
 return <div style={{...panel,maxWidth:760,padding:'24px 16px',margin:'0 auto',color:'var(--dt-foreground)'}}>
  <header><h2 style={{fontSize:22,margin:'0 0 8px'}}>{c('title')}</h2><p style={hint}>{c('intro')}</p></header>
  <nav aria-label={c('title')} style={{display:'flex',gap:6,flexWrap:'wrap',borderBottom:divider,paddingBottom:12}}>{steps.map(n=><Button key={n} size="sm" variant={step===n?'secondary':'ghost'} aria-current={step===n?'step':undefined} disabled={testing} onClick={()=>setStep(n)}>{c(labels[n]!)}</Button>)}</nav>
  {!local&&<p role="status">{c('localOnly')} <Button onClick={callSettings}>{c('callSettings')}</Button></p>}
  {step===0&&<div style={panel}>
   <label><input type="radio" name="live-setup-mode" checked={mode==='wake'} onChange={()=>setMode('wake')}/> {c('wakeMode')}<p style={hint}>{c('wakeHint')}</p></label>
   <label><input type="radio" name="live-setup-mode" checked={mode==='call'} onChange={()=>setMode('call')}/> {c('manualMode')}<p style={hint}>{c('manualHint')}</p></label>
   {mode==='wake'&&data&&!data.assets.supported&&<p role="alert">{c('localOnly')}</p>}
  </div>}
  {step===1&&local&&<div style={panel}>
   <p style={hint}>{c('selectBots')}</p>
   {host.pluginDecisions?.get()['hermes-bots']===false&&<p style={hint}>{c('botsDisabled')} <Button size="sm" onClick={()=>host.navigate('/capabilities?tab=plugins')}>{c('manage')}</Button></p>}
   <WakeSettings rest={ctx.rest} local={local} changed={()=>void load()}/>
   <GenericWakeSettings rest={ctx.rest} local={local} changed={()=>void load()}/>
   <Button variant="ghost" onClick={()=>host.revealPane?.('hermes-bots:pane')}>{c('botsView')}</Button>
  </div>}
  {step===2&&<div style={panel}>
   <p style={hint}>{c('authHint')}</p>
   {auth?.available?<p role="status">{c('signedIn')}</p>:<>
    {auth?.reason&&<p role="status">{localizeError(t,auth.reason)}</p>}
    {auth?.authState==='cli_missing'?<Button onClick={()=>void ctx.os?.openExternal('https://developers.openai.com/codex/cli/')}>{c('installCodex')}</Button>:
     <Button disabled={loading||['starting','waiting'].includes(login.state)} onClick={()=>void action(async()=>setLogin(await ctx.rest('/setup/login',{method:'POST'})))}>{c('login')}</Button>}
    {['starting','waiting'].includes(login.state)&&<p role="status">{c('waitingLogin')}</p>}
    {login.url&&<Button variant="ghost" onClick={()=>void ctx.os?.openExternal(login.url!)}>{c('openLogin')}</Button>}
    {['starting','waiting'].includes(login.state)&&<Button variant="ghost" onClick={()=>void action(async()=>setLogin(await ctx.rest('/setup/login',{method:'DELETE'})))}>{c('cancel')}</Button>}
    {['error','expired','cancelled'].includes(login.state)&&<p role="alert">{c('loginFailed')}</p>}
    <details><summary>{c('loginCli')}</summary><p><code>codex login</code></p><a href="https://developers.openai.com/codex/auth/" target="_blank" rel="noreferrer">Codex</a></details>
   </>}
   <Button variant="ghost" disabled={loading} onClick={()=>void checkAuth()}>{c('refresh')}</Button>
   {mode==='call'&&<Button onClick={callSettings}>{c('callSettings')}</Button>}
  </div>}
  {step===3&&local&&<div style={panel}>
   <p style={hint}>{c('modelHint')}</p><strong>Whisper {data?.assets.model??'Small'} · {Math.ceil((data?.assets.bytes??487601967)/1000000)} MB</strong>
   <p style={hint}>{c(data?.assets.source==='existing'?'existing':'managed')}</p>
   {data?.assets.prepared?<p role="status">{c('modelReady')}</p>:preparingModel(data?.assets)?<>
    <p role="status">{c(progress?.state as 'downloading'|'verifying'|'preparing')}{progress?.state==='downloading'&&` · ${Math.floor((progress.received??0)/1000000)} / ${Math.ceil((progress.total??0)/1000000)} MB`}</p>
    {progress?.state==='downloading'&&<progress aria-label={c('downloading')} max={progress.total} value={progress.received} style={{width:'100%'}}/>}
    <Button variant="ghost" onClick={()=>void action(async()=>{await ctx.rest('/setup/model',{method:'DELETE'});await load()})}>{c('cancelDownload')}</Button>
   </>:<Button disabled={loading||!data?.assets.supported||!data.assets.engine} onClick={()=>void model()}>{c(data?.assets.installed?'recheckModel':'download')}</Button>}
   {data?.assets.supported&&!data.assets.engine&&<p role="alert">{c('engineMissing')}</p>}
   {errorText&&<p role="alert">{errorText}</p>}<p style={hint}>{c(data?.assets.installed?'prepareHint':'downloadHint')}</p>
  </div>}
  {step===4&&<div style={panel}>
   <p style={hint}>{c('audioHint')}</p>
   {mode==='call'?<DeviceSettings value={devices} active={block} onChange={value=>{setDevices(value);ctx.storage.set('audio-devices',value)}}/>:<>
    <Button disabled={block} onClick={()=>void permission()}>{c('grantMic')}</Button>
    {data?.audio.error&&<p role="alert">{setupError(locale,'HL_SETUP:'+data.audio.error)}</p>}
    <FieldSelect label={c('audio')} value={device} disabled={block} options={(data?.audio.devices??[]).filter(n=>!data?.audio.duplicates.includes(n)).map(n=>({value:n,label:n}))} onChange={(n:string)=>{setDevice(n);setNote('')}}/>
    <Button disabled={block||!device||!data?.assets.installed} onClick={()=>void saveDevice()}>{c('saveMic')}</Button>
    <Button disabled={block||data?.device!==device||!data?.enabled} onClick={()=>{captureTask.current=capture('mic')}}>{c('testMic')}</Button>
    <progress aria-label={c('audio')} max={1} value={level} style={{width:'100%'}}/>
    <Button variant="ghost" onClick={()=>void ctx.os?.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')}>{c('permission')}</Button>
   </>}
   <label>{c('cueVolume')} <input aria-label={c('cueVolume')} type="range" min="0" max="1" step="0.1" value={volume} onChange={e=>{const n=Number(e.target.value);setVolume(n);ctx.storage.set('wake-cue-volume',n)}}/></label>
   <Button variant="ghost" onClick={()=>void playWakeCue(devices.output,volume)}>{c('cue')}</Button>
  </div>}
  {step===5&&local&&<div style={panel}>
   <FieldSelect label={c('bots')} value={target} options={targets.map(t=>({value:t.target,label:t.display_name}))} disabled={block} onChange={setTarget}/>
   <strong style={{fontSize:23}}>{selected?.phrases[0]??((generic&&genericPhrase)||'…')}</strong><p style={hint}>{c('testHint')}</p>
   <Button disabled={block||!basicReady(data)||(!selected&&!generic)} onClick={()=>{captureTask.current=capture('wake')}}>{c('testWake')}</Button>
   <p style={hint}>{c('trialHint')}</p>
   <Button disabled={block||!basicReady(data)||!selected} onClick={()=>void action(()=>trial(target))}>{c('trial')}</Button>
   <p role="status">{c(ctx.storage.get<string>(`setup-trial:${target}`,'')==='ended'?'verified':'unverified')}</p>
  </div>}
  {step===6&&<div style={panel}>
   {!complete&&mode==='wake'&&<p role="status">{c('intro')} <Button onClick={()=>setStep(!targets.length&&!generic?1:!auth?.available?2:!data?.assets.installed?3:4)}>{c('next')}</Button></p>}
   <p>{c('readyHint')}</p>{mode==='wake'?<p>{targets.map(t=>t.display_name).join(', ')||'—'} · {data?.device||'—'}</p>:<p role="status">{c('manualReady')}</p>}
   {mode==='wake'&&<><p>{targets.map(t=>t.phrases[0]+' / Bye '+t.display_name).join(' · ')}</p>
    <p role="status">{targets.map(t=>`${t.display_name}: ${c(ctx.storage.get<string>(`setup-trial:${t.target}`,'')==='ended'?'verified':'unverified')}`).join(' · ')}</p>
    <label><input type="checkbox" checked={auto} onChange={e=>{setAuto(e.target.checked);ctx.storage.set('hands-free-enabled',e.target.checked)}}/> {c('autoStart')}</label><p style={hint}>{c('resumeHint')}</p>
    <Button disabled={block||!complete||listening()} onClick={()=>void action(async()=>{if(await standby())setNote(c('standby'))})}>{c(listening()?'standby':'begin')}</Button>
    {listening()&&<p role="status">{c('standby')}</p>}
   </>}
   <Button variant="ghost" onClick={callSettings}>{c('callSettings')}</Button>
  </div>}
  {testing&&<Button variant="secondary" onClick={()=>cancel.current?.abort()}>{c('stopTest')}</Button>}
  {!['idle','error'].includes(currentCall)&&<Button onClick={stop}>{c('endCall')}</Button>}
  {note&&<p role="status" style={hint}>{note}</p>}{error&&<div role="alert"><p>{error}</p><Button size="sm" variant="ghost" onClick={()=>host.navigate(settingsHref(host.state.profile.get()||'default'))}>{c('manage')}</Button></div>}
  <footer style={{display:'flex',gap:8,flexWrap:'wrap',borderTop:divider,paddingTop:16}}>
   <Button variant="ghost" disabled={testing} onClick={()=>host.navigate('/')}>{c('later')}</Button>
   <Button variant="ghost" disabled={loading} onClick={()=>void load()}>{c(loading?'checking':'refresh')}</Button>
   {step>0&&<Button variant="ghost" disabled={block} onClick={()=>setStep(steps[Math.max(0,steps.indexOf(step)-1)]!)}>{c('back')}</Button>}
   {step<6&&<Button disabled={block||!canNext||(mode==='wake'&&(!local||!data?.assets.supported))} onClick={next}>{c('next')}</Button>}
  </footer>
 </div>;
}
