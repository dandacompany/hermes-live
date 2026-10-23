import {bundles,localizeError,formatNumber,type Translate} from './i18n.ts';
import {useLiveI18n} from './i18n-react.ts';
import {FieldSelect,hint,divider} from './ui.tsx';
import {AuthSettings} from './auth-settings.tsx';
import {settingsHref} from './auth.ts';
import {DeviceSettings} from './device-settings.tsx';
import {UsageSettings,type Quota} from './usage-settings.tsx';
import {defaultDevices,type AudioDevices} from './devices.ts';
import {UsageLedger,emptyUsage,type UsageData} from './usage.ts';
import {seedHistory,draftVoicePrompt,voiceSubmission,historyParams} from './context.ts';
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Button,Popover,PopoverContent,PopoverTrigger,Tip,COMPOSER_AREAS,host,icons,SegmentedControl} from '@hermes/plugin-sdk';
import type {PluginContext,Route} from '@hermes/plugin-sdk';
import {CallController} from './controller.ts';
import {AudioEngine} from './audio.ts';
import {CodexMedia,CodexRTC} from './codex.ts';
import {QwenRTC} from './qwen.ts';
import {LiveSocket} from './providers.ts';
import {HermesBridge,sameScope,ownedScope} from './hermes-bridge.ts';
import type {Scope,Message} from './hermes-bridge.ts';
import type {CatalogItem,Connection,Selection} from './types.ts';
import type {CallState} from './controller.ts';

function Icon({name,size=16}:{name:'live'|'mic'|'muted'|'end'|'close';size?:number}){
 const paths={live:<><path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"/></>,mic:<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></>,muted:<><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M12 19v3m-4 0h8"/></>,end:<path d="M4 15c-1 0-2-1-2-2v-2c5-6 15-6 20 0v2c0 1-1 2-2 2l-4-2v-3a14 14 0 0 0-8 0v3z"/>,close:<path d="m6 6 12 12M6 18 18 6"/>};
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
const mutedStyle=hint;
const controlSize='var(--composer-control-size, 24px)';
const primarySize='var(--composer-control-primary-size, var(--composer-control-size, 24px))';
const defaults:Selection={provider:'gemini',model:'gemini-3.8-live',voice:'Kore'};
const providerNames={qwen:'Alibaba Qwen Realtime',gemini:'Google Gemini Live',grok:'xAI Grok Voice',codex:'Codex subscription · GPT Live'};
function CallWave({state}:{state:CallState}){
 const speaking=state.status==='speaking';const level=state.muted?0:Math.max(0,Math.min(1,state.level));
 return <span aria-hidden="true" style={{display:'flex',height:12,alignItems:'center',gap:2}}>
  <style>{'@keyframes hermes-live-wave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}@media(prefers-reduced-motion:reduce){.hermes-live-wave{animation:none!important}}'}</style>
  {[.55,.85,1,.85,.55].map((weight,i)=><span key={i} className="hermes-live-wave" style={{width:2,borderRadius:2,background:'currentColor',height:speaking?12:(.3+Math.min(.7,level*weight))*12,transition:'height 100ms ease',animation:speaking?`hermes-live-wave ${.55+i*.07}s ease-in-out ${i*-.12}s infinite`:undefined}}/>)}
 </span>;
}
function currentScope():Scope{
 return ownedScope(host.state.focusedSessionOwner.get(),host.state.focusedSessionId.get());
}
function apiScopeMatches(scope:Scope){return scope.connection===(host.state.connectionId.get()||'local')&&scope.profile===(host.state.profile.get()||'default')}

export default {
 id:'hermes-live',name:'Hermes Live',version:'0.9.0',description:'Gemini · Grok · Qwen · Codex subscription live calls',defaultEnabled:false,
 register(ctx:PluginContext){
  ctx.i18n.register(bundles);
  const t=ctx.i18n.t as Translate;
  const listeners=new Set<()=>void>();let callOwner:Scope|null=null;let allowSessionAdopt=false;let route:Route|null=null;
  let ledger:UsageLedger|null=null;let ledgerKey='';let storageErrorShown=false;
  const usageKey=(scope:Scope)=>`usage:v1:${scope.connection}:${scope.profile}`;
  const devices=()=>ctx.storage.get<AudioDevices>('audio-devices',defaultDevices);
  const bridge=new HermesBridge({
   current:currentScope,
   busy:id=>id?Boolean(host.state.busyBySession.get()[id]):host.state.busy.get(),
   history:async scope=>{
    if(!route||route.connectionId!==scope.connection||route.profile!==scope.profile)throw new Error("HL_ERROR:errScope");
    const result=await host.requestProfile<{messages:Message[]}>(route,'session.history',historyParams(scope.session!));return result.messages;
   },
   submit:async(session,text,voiceContext)=>{
    const owner=currentScope();
    if(!route||route.connectionId!==owner.connection||route.profile!==owner.profile||session!==owner.session)throw new Error("HL_ERROR:errScope");
    if(!session){const prompt=draftVoicePrompt(text,voiceContext);return host.composer.submit(null,prompt)?prompt:false}
    await host.requestProfile(route,'prompt.submit',voiceSubmission(session,text,voiceContext,crypto.randomUUID()));
    return true;
   },
   adopt:scope=>{if(allowSessionAdopt)callOwner=scope},
  });
  const controller=new CallController({
   prepare:async (signal,selection)=>{
    const owner=callOwner&&{...callOwner};
    if(!owner||!apiScopeMatches(owner)||!sameScope(owner,currentScope()))throw new Error("HL_ERROR:errScope");
    const routes=await host.profileRoutes();
    if(signal.aborted)return;
    if(!callOwner||!sameScope(owner,callOwner)||!sameScope(owner,currentScope()))throw new Error("HL_ERROR:errScope");
    route=routes.find(r=>r.connectionId===owner.connection&&r.profile===owner.profile)??null;
    if(!route)throw new Error("HL_ERROR:errScope");
    const result=await ctx.rest<{provider:CatalogItem}>('/readiness',{method:'POST',body:{provider:selection.provider},timeoutMs:30000});
    if(signal.aborted)return;
    if(!apiScopeMatches(owner)||!sameScope(owner,currentScope())||!callOwner||!sameScope(owner,callOwner))throw new Error("HL_ERROR:errScope");
    if(!result.provider.available)throw new Error(result.provider.reason||"HL_ERROR:errKey");
   },
   audio:(speaking,selection)=>['codex','qwen'].includes(selection.provider)?new CodexMedia(speaking,devices()):new AudioEngine(speaking,devices()),
   token:async selection=>{
    if(!callOwner||!apiScopeMatches(callOwner)||!sameScope(callOwner,currentScope()))throw new Error("HL_ERROR:errScope");
    const owner={...callOwner};
    if(!route)throw new Error("HL_ERROR:errScope");
    const rows=owner.session?await host.requestProfile<{messages:Message[]}>(route,'session.history',historyParams(owner.session)):{messages:[]};
    if(!sameScope(owner,currentScope())||!callOwner||!sameScope(owner,callOwner))throw new Error("HL_ERROR:errScope");
    const history=seedHistory(rows.messages);
    if(['codex','qwen'].includes(selection.provider))return {...selection,token:'',sampleRate:48000,history};
    const result=await ctx.rest<Connection>('/connect',{method:'POST',body:selection,timeoutMs:40000});
    if(!callOwner||!apiScopeMatches(callOwner)||!sameScope(callOwner,currentScope()))throw new Error("HL_ERROR:errScope");
    return {...result,history};
   },
   transport:(config,emit,audio)=>{
    if(!['codex','qwen'].includes(config.provider))return new LiveSocket(config,emit);
    const owner={...callOwner!};
    const RTC=config.provider==='qwen'?QwenRTC:CodexRTC;
    return new RTC(config,audio as CodexMedia,async<T,>(path:string,body:unknown,timeoutMs=10000):Promise<T>=>{
     if(!apiScopeMatches(owner))throw new Error("HL_ERROR:errScope");
     return ctx.rest<T>(path,{method:'POST',body,timeoutMs});
    },emit);
   },
   delegate:async(text,signal,voiceContext)=>{allowSessionAdopt=true;try{return await bridge.run(text,signal,voiceContext)}finally{allowSessionAdopt=false}},
   connected:selection=>{
    ledgerKey=usageKey(callOwner!);const key=ledgerKey;
    ledger=new UsageLedger(ctx.storage.get<UsageData>(key,emptyUsage()),data=>{try{ctx.storage.set(key,data)}catch{if(!storageErrorShown){storageErrorShown=true;host.notify({kind:'error',message:t('storageError')})}}});ledger.begin(selection);
   },
   usage:event=>{if(event.type==='usage')ledger?.tokens(event.tokens);if(event.type==='audioUsage')ledger?.audio(event.audioMs)},
   ended:()=>{ledger?.end();ledger=null},
   changed:()=>listeners.forEach(fn=>fn()),
  });
  const stop=()=>{controller.stop();callOwner=null;allowSessionAdopt=false;route=null};
  ctx.onDispose(stop);
  ctx.setInterval(()=>ledger?.flush(),5000);
  ctx.setInterval(()=>{
   if(!callOwner)return;const now=currentScope();
   if(allowSessionAdopt&&!callOwner.session&&now.session&&callOwner.connection===now.connection&&callOwner.profile===now.profile)callOwner=now;
   if(!sameScope(callOwner,now)||!apiScopeMatches(callOwner)){stop();host.notify({kind:'info',message:t('scopeEnded')})}
  },250);

  function LiveButton(){
   const {t,locale}=useLiveI18n();
   const providerName=(id:Selection["provider"])=>id==="codex"?t("codexProvider"):providerNames[id];
   const state=useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>controller.snapshot);
   const focusedOwner=useSyncExternalStore(fn=>host.state.focusedSessionOwner.subscribe(fn),()=>host.state.focusedSessionOwner.get());
   const scopeKey=`selection:${focusedOwner?.connectionId??''}:${focusedOwner?.profile??''}`;
   const savedSelection=()=>ctx.storage.get<Selection>(scopeKey,defaults);
   const [tab,setTab]=useState<'call'|'audio'|'usage'>('call');const [deviceChoice,setDevices]=useState<AudioDevices>(devices);
   const [backend,setBackend]=useState('');
   const [open,setOpen]=useState(false);const [catalog,setCatalog]=useState<CatalogItem[]>([]);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
   const [draftSelection,setSelection]=useState<Selection>(savedSelection);const selection=state.selection??draftSelection;const [now,setNow]=useState(Date.now());const scroll=useRef<HTMLDivElement>(null);const mounted=useRef(true);const loadId=useRef(0);
   useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
   const active=!['idle','error'].includes(state.status);
   useEffect(()=>{++loadId.current;setSelection(savedSelection());setCatalog([]);setBackend('');setError('');setLoading(false);setOpen(false)},[scopeKey]);
   useEffect(()=>{if(state.status==='error'){setOpen(true);void load()}},[state.status]);
   useEffect(()=>{if(!active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[active]);
   useEffect(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight},[state.transcript]);
   const load=async()=>{
    const id=++loadId.current;setLoading(true);setError('');const scope=currentScope();
    try{
     if(!apiScopeMatches(scope))throw new Error("HL_ERROR:errScope");
     const value=await ctx.rest<{providers:CatalogItem[];backend:string}>('/catalog',{timeoutMs:30000});
     if(!mounted.current||id!==loadId.current||!sameScope(scope,currentScope())||!apiScopeMatches(scope))return;
     setBackend(value.backend);setCatalog(value.providers);
     const saved=controller.snapshot.selection??savedSelection();
     const p=value.providers.find(x=>x.id===saved.provider)??value.providers[0];
     if(p)setSelection({provider:p.id,model:p.models.some(m=>m.id===saved.model)?saved.model:p.models[0]!.id,voice:p.voices.includes(saved.voice)?saved.voice:p.voices[0]!});
    }catch{if(mounted.current&&id===loadId.current)setError("HL_ERROR:errBackend")}
    finally{if(mounted.current&&id===loadId.current)setLoading(false)}
   };
   const change=(next:Selection)=>{if(controller.snapshot.status==='error')controller.stop();setError('');setSelection(next);ctx.storage.set(scopeKey,next)};
   const configure=()=>{
    const scope=currentScope();
    if(!apiScopeMatches(scope)){setError('HL_ERROR:errScope');return}
    setOpen(false);host.navigate(settingsHref(scope.profile));
   };
   const start=async()=>{
    if(!['idle','error'].includes(controller.snapshot.status))return;
    setError('');setOpen(false);callOwner=currentScope();await controller.start(savedSelection());
   };
   const provider=catalog.find(p=>p.id===selection.provider);const seconds=state.startedAt?Math.floor((now-state.startedAt)/1000):0;
   const key=usageKey(currentScope());const usage=ledger&&ledgerKey===key?ledger.data:ctx.storage.get<UsageData>(key,emptyUsage());
   const readQuota=async()=>{const scope=currentScope();if(!apiScopeMatches(scope))throw new Error("HL_ERROR:errScope");const value=await ctx.rest<Quota>('/codex/usage',{timeoutMs:40000});if(!sameScope(scope,currentScope()))throw new Error("HL_ERROR:errScope");return value};
   const label=state.muted&&state.status==='listening'?t('muted'):{idle:t('idle'),connecting:t('preparing'),listening:t('listening'),speaking:t('speaking'),thinking:t('thinking'),error:t('errorStatus')}[state.status];
   return <span role="group" aria-label={t('call')} style={{order:1,display:'inline-flex',alignItems:'center',flexShrink:0,gap:4}}>
    {active&&<Tip label={state.muted?t('unmute'):t('mute')} placement="control"><Button type="button" variant="ghost" size="icon" aria-label={state.muted?t('unmute'):t('mute')} aria-pressed={state.muted} onClick={()=>controller.mute()} style={{height:controlSize,width:controlSize,padding:0}}><Icon name={state.muted?'muted':'mic'}/></Button></Tip>}
    <span style={{display:'inline-flex',alignItems:'center'}}>
    <Tip label={active?t('actionTip',label,state.status==='connecting'?t('cancel'):t('end')):t('startTip',providerName(selection.provider),selection.voice)} placement="control"><Button type="button" variant="default" size={active?'sm':'icon'} aria-label={active?(state.status==='connecting'?t('cancelConnection'):t('endCall')):t('start')} aria-pressed={active} aria-busy={state.status==='connecting'} onClick={()=>active?stop():void start()} style={{height:active?controlSize:primarySize,width:active?undefined:primarySize,padding:active?'0 12px':0,gap:6,borderRadius:999}}>{active?<><CallWave state={state}/><span>{state.status==='connecting'?t('preparing'):t('end')}</span></>:<icons.AudioLines className={icons.iconSize.sm}/>}</Button></Tip>
    <Popover open={open} onOpenChange={(v:boolean)=>{setOpen(v);if(v)void load()}}>
    <Tip label={t('settingsHint')} placement="control"><PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={t('callSettings')} style={{height:controlSize,width:20,padding:0,borderRadius:4}}><icons.ChevronDown className={icons.iconSize.xs}/></Button></PopoverTrigger></Tip>
    {/* Keep default autofocus: Hermes focus-follow preserves focus inside overlays. */}
    <PopoverContent lang={locale} align="end" side="top" sideOffset={8} style={{width:'24rem',maxWidth:'calc(100vw - 24px)',padding:0,maxHeight:'min(40rem, var(--radix-popover-content-available-height, calc(100vh - 32px)))',display:'flex',flexDirection:'column'}}>
     <header style={{padding:16,display:'grid',gap:12,flexShrink:0,borderBottom:divider}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}><strong style={{fontSize:'.875rem'}}>{t('settings')}</strong><Button size="icon" variant="ghost" aria-label={t('close')} onClick={()=>setOpen(false)} style={{height:28,width:28}}><Icon name="close"/></Button></div>
      <div role="group" aria-label={t('callSettings')}><SegmentedControl className="w-full" value={tab} onChange={(value:'call'|'audio'|'usage')=>setTab(value)} options={(['call','audio','usage'] as const).map(id=>({id,label:t(id)}))}/></div>
     </header>
     <div style={{padding:16,minHeight:0,overflowY:'auto',display:'grid',gap:16}}>
     {tab==='audio'&&<DeviceSettings value={deviceChoice} active={active} onChange={value=>{setDevices(value);ctx.storage.set('audio-devices',value)}}/>}
     {tab==='usage'&&<UsageSettings key={scopeKey} data={usage} selection={selection} readQuota={readQuota}/>}
     {tab==='call'&&<><div style={{display:'grid',gap:12}}>
      <FieldSelect label={t('provider')} value={selection.provider} disabled={active||loading} options={(catalog.length?catalog:[{id:selection.provider,available:true}]).map(p=>({value:p.id,label:providerName(p.id)+(p.available?'':` · ${t('setupNeeded')}`)}))} onChange={value=>{const p=catalog.find(p=>p.id===value);if(p)change({provider:p.id,model:p.models[0]!.id,voice:p.voices[0]!})}}/>
      <FieldSelect label={t('model')} value={selection.model} disabled={active||loading} options={provider?provider.models.map(m=>({value:m.id,label:selection.provider==='codex'?t('codexModel'):m.name})):[{value:selection.model,label:selection.model}]} onChange={model=>change({...selection,model})}/>
      <FieldSelect label={t('voice')} value={selection.voice} disabled={active||loading} options={(provider?.voices??[selection.voice]).map(value=>({value,label:value}))} onChange={voice=>change({...selection,voice})}/>
     </div>
     <div role="status" style={{...mutedStyle,display:'flex',alignItems:'center',gap:8}}>{loading?t('checking'):provider&&!provider.available&&!active?t('setupNeeded'):label}{state.startedAt>0&&<span style={{marginInlineStart:8,fontVariantNumeric:'tabular-nums'}}><bdi>{formatNumber(locale,Math.floor(seconds/60))}:{new Intl.NumberFormat(locale,{minimumIntegerDigits:2}).format(seconds%60)}</bdi></span>}</div>
     {(error||state.error||provider?.reason)&&<div role="alert" style={{...mutedStyle,padding:'8px 10px',borderRadius:'var(--radius-sm)',background:'var(--ui-bg-tertiary)',border:divider}}>{localizeError(t,error||state.error||provider?.reason)}{error&&<Button variant="ghost" size="sm" onClick={()=>void load()}>{t('retry')}</Button>}</div>}
     <AuthSettings provider={provider} selected={selection.provider} backend={backend} connection={currentScope().connection} profile={currentScope().profile} active={active} loading={loading} configure={configure} recheck={()=>void load()}/>
     {state.transcript.length>0&&<div ref={scroll} style={{maxHeight:150,overflowY:'auto',fontSize:12,lineHeight:1.65,borderTop:divider,paddingTop:12}} aria-label={t('transcripts')}>{state.transcript.map((fragment,i)=><p key={i} style={{margin:'0 0 8px'}}><span style={{...mutedStyle,marginInlineEnd:6}}>{fragment.speaker==='user'?t('you'):'Live'}</span>{fragment.text}</p>)}</div>}
     </>}
     </div>
     {tab==='call'&&<footer style={{...mutedStyle,padding:'12px 16px',borderTop:divider,flexShrink:0}}>{selection.provider==='codex'?t('subscriptionNotice'):t('apiNotice')}<br/>{t('endExisting')}</footer>}
    </PopoverContent>
   </Popover></span><span role="status" className="sr-only">{active?label:localizeError(t,state.error)}</span></span>;
  }
  ctx.register({id:'call',area:COMPOSER_AREAS.actions,order:20,render:()=> <LiveButton/>});
 }
};
