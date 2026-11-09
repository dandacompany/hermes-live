import {Setup} from './setup.tsx';
import {VoicePause} from './voice-pause.ts';
import {basicReady,type SetupState} from './setup-state.ts';
import {setupCopy,setupError} from './setup-copy.ts';
import {playWakeCue} from './wake-cue.ts';
import {WakeCoordinator,VoiceActivity,type WakeConfig,type WakeStatus,type WakeEvent} from './wake.ts';
import {bundles,localizeError,formatNumber,type Translate} from './i18n.ts';
import {useLiveI18n} from './i18n-react.ts';
import {FieldSelect,hint,divider} from './ui.tsx';
import {AuthSettings} from './auth-settings.tsx';
import {settingsHref} from './auth.ts';
import {DeviceSettings} from './device-settings.tsx';
import {matchWakeTarget} from '../dashboard/wake-phrase.mjs';
import {openWakeBot,wakeBotReady,ProfileTransition} from './wake-navigation.ts';
import {HoverControls} from './hover-controls.tsx';
import {WakeSettings} from './wake-settings.tsx';
import {GenericWakeSettings} from './generic-wake-settings.tsx';
import {UsageSettings,type Quota} from './usage-settings.tsx';
import {defaultDevices,selectWakeMicrophone,canonicalMicrophoneLabel,type AudioDevices} from './devices.ts';
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

function Icon({name,size=16}:{name:'live'|'mic'|'muted'|'end'|'close'|'wake'|'settings';size?:number}){
 const paths={wake:<><path d="M6 9a6 6 0 0 1 12 0c0 4-4 4-4 7a4 4 0 0 1-8 0M10 9a2 2 0 0 1 4 0c0 2-3 2-3 5"/></>,settings:<><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/></>,live:<><path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"/></>,mic:<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></>,muted:<><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M12 19v3m-4 0h8"/></>,end:<path d="M4 15c-1 0-2-1-2-2v-2c5-6 15-6 20 0v2c0 1-1 2-2 2l-4-2v-3a14 14 0 0 0-8 0v3z"/>,close:<path d="m6 6 12 12M6 18 18 6"/>};
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
 id:'hermes-live',name:'Hermes Live',version:'0.11.5',description:'Gemini · Grok · Qwen · Codex subscription live calls',defaultEnabled:false,
 register(ctx:PluginContext){
  ctx.i18n.register(bundles);
  const t=ctx.i18n.t as Translate;
  let trialProfile:string|null=null;let trialConnected=false;
  let wake:WakeCoordinator;let wakeCall=false;let wakeNames:string[]=[];let wakeGreeting:Connection['wakeGreeting'];
  const activity=new VoiceActivity(active=>{if(active&&!['idle','error'].includes(controller.snapshot.status))stop();void wake?.tick()});
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
   goodbye:()=>wakeCall,goodbyeNames:()=>wakeNames,
   voiceControl:text=>{
    if(!wake.enabled)return false;
    const target=matchWakeTarget(text,wake.config?.targets??[]);
    if(!target)return false;
    if(target===callOwner?.profile)return true;
    const previous=callOwner&&{...callOwner},previousRoute=route;
    void wake.handoff(target,async()=>{
     stop();
     if(previous?.session&&previousRoute&&host.state.busyBySession.get()[previous.session]){
      await host.requestProfile(previousRoute,'session.interrupt',{session_id:previous.session});
      const deadline=Date.now()+3000;
      while(host.state.busyBySession.get()[previous.session]&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
     }
    });return true;
   },
   isVoiceControl:text=>Boolean(wake.enabled&&matchWakeTarget(text,wake.config?.targets??[])),
   prepare:async (signal,selection)=>{
    await wake?.suspend();if(signal.aborted)return;
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
    // Codex history remains in Hermes and is consulted through delegation on demand.
    // Sending old turns through its active append channel can cause unsolicited playback.
    if(selection.provider==='codex')return {...selection,token:'',sampleRate:48000,...(wakeGreeting?{wakeGreeting}:{})};
    const rows=owner.session?await host.requestProfile<{messages:Message[]}>(route,'session.history',historyParams(owner.session)):{messages:[]};
    if(!sameScope(owner,currentScope())||!callOwner||!sameScope(owner,callOwner))throw new Error("HL_ERROR:errScope");
    const history=seedHistory(rows.messages);
    if(['codex','qwen'].includes(selection.provider))return {...selection,token:'',sampleRate:48000,history,...(wakeGreeting?{wakeGreeting}:{})};
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
    if(trialProfile&&trialProfile===callOwner?.profile){trialConnected=true;ctx.storage.set(`setup-trial:${trialProfile}`,'connected')}
    ledgerKey=usageKey(callOwner!);const key=ledgerKey;
    ledger=new UsageLedger(ctx.storage.get<UsageData>(key,emptyUsage()),data=>{try{ctx.storage.set(key,data)}catch{if(!storageErrorShown){storageErrorShown=true;host.notify({kind:'error',message:t('storageError')})}}});ledger.begin(selection);
   },
   usage:event=>{if(event.type==='usage')ledger?.tokens(event.tokens);if(event.type==='audioUsage')ledger?.audio(event.audioMs)},
   ended:()=>{if(trialProfile&&trialConnected)ctx.storage.set(`setup-trial:${trialProfile}`,'ended');trialProfile=null;trialConnected=false;callOwner=null;route=null;allowSessionAdopt=false;ledger?.end();ledger=null;const wasWake=wakeCall;wakeCall=false;wakeNames=[];wakeGreeting=undefined;wake?.ended();if(wasWake)chime(440)},
   changed:()=>listeners.forEach(fn=>fn()),
  });
  const stop=()=>{controller.stop();callOwner=null;allowSessionAdopt=false;route=null};
  function chime(hz:number){
   const ac=new AudioContext();const tone=ac.createOscillator();const gain=ac.createGain();tone.frequency.value=hz;gain.gain.value=.035;tone.connect(gain);gain.connect(ac.destination);tone.start();gain.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.16);tone.stop(ac.currentTime+.18);tone.onended=()=>void ac.close();void ac.resume().catch(()=>void ac.close());
  }
  async function startWake(config:WakeConfig,current:()=>boolean){
   if(voiceMode.paused)throw new Error('HL_ERROR:errBusy');
   const initial=host.state.profile.get();const transition=new ProfileTransition(initial,config.target,host.state.connectionId.get()||'local');
   const unsubscribe=host.state.profile.subscribe(profile=>{transition.observe(profile,currentScope())});
   const valid=()=>current()&&!transition.cancelled;
   try{
    // Resolve the physical device before switching the active gateway.
    const selected=selectWakeMicrophone(await navigator.mediaDevices.enumerateDevices(),config.input_device);
    if(!valid()||host.state.busy.get()||Object.values(host.state.busyBySession.get()).some(Boolean))throw new Error('HL_ERROR:errBusy');
    void playWakeCue(devices().output,ctx.storage.get('wake-cue-volume',1));
    ctx.storage.set('audio-devices',{...devices(),input:selected.deviceId});
    const selectionKey=`selection:${host.state.connectionId.get()||'local'}:${config.target}`;
    const saved=ctx.storage.get<Selection|null>(selectionKey,null);
    const selection:Selection={provider:'codex',model:'gpt-live-1-codex',voice:saved?.provider==='codex'&&saved.voice?saved.voice:'cove'};
    ctx.storage.set(selectionKey,selection);
    if(activity.active)throw new Error('HL_ERROR:errBusy');
    if((host.state.profile.get()||'default')!==config.target)await wake.releaseForNavigation();
    // Settings hides the workspace; close it before the SDK takes a Bot Chat ownership token.
    host.navigate('/');await new Promise(r=>setTimeout(r,0));
    const targetConnection=host.state.connectionId.get()||'local';
    if(!host.state.focusedStoredSessionId)throw new Error('HL_ERROR:errBotsView');
    const stored=await openWakeBot({routes:()=>host.profileRoutes(),activate:route=>host.ensureAgent(null,route.profile),isSelected:(stored,route)=>{const scope=currentScope();return scope.profile===route.profile&&scope.connection===route.connectionId&&host.state.focusedStoredSessionId!.get()===stored},request:(route,method,params)=>host.requestProfile(route,method,params),revealPane:host.revealPane,
     paneVisible:host.paneVisibility?id=>host.paneVisibility!(id).get():undefined,
     label:host.setWorkspaceOwnerLabel,openSession:host.openSession},
     config.target,targetConnection,config.names?.[0]||config.target,valid);
    const deadline=Date.now()+10000;
    const ready=(scope:Scope)=>wakeBotReady(scope,config.target,targetConnection,stored,host.state.focusedStoredSessionId!.get());
    while(valid()&&Date.now()<deadline){if(ready(currentScope()))break;await new Promise(r=>setTimeout(r,50))}
    const scope=currentScope();if(!valid()||!ready(scope))throw new Error('HL_ERROR:errScope');
    await host.ensureAgent(null,config.target);
    transition.seal();
    if(!valid()||!sameScope(scope,currentScope())||!apiScopeMatches(scope))throw new Error('HL_ERROR:errScope');
    if(activity.active)throw new Error('HL_ERROR:errBusy');
    callOwner=scope;wakeNames=[...(config.names??[])];wakeCall=true;wakeGreeting={name:config.names?.[0]||config.target,phrase:config.phrase};await controller.start(selection);
    if(controller.snapshot.status==='error')throw new Error(controller.snapshot.error);
   }catch(error){stop();host.notify({kind:'error',message:localizeError(t,error instanceof Error?error.message:'HL_ERROR:errGeneric')});throw error}
   finally{unsubscribe()}
  }
  /** Generic wake phrase: the call button's path (focused chat, its own agent) on the Codex subscription like a named wake. */
  async function startFocused(config:WakeConfig,current:()=>boolean){
   if(voiceMode.paused)throw new Error('HL_ERROR:errBusy');
   // Stop only a call this attempt started: a manual call begun while devices were listed must stay up.
   // That call also keeps the wake lease paused (no rethrow below): its end, not this failure, re-arms listening.
   let owned=false;
   try{
    // No profile switch and no Bots navigation: the focused chat must already be on the active local backend.
    // A draft (no saved session) resolves to the active owner like the call button; null means the owner is unknown.
    const scope=currentScope();
    if(!host.state.focusedSessionOwner.get()||!scope.profile)throw new Error('HL_ERROR:errNoFocusedChat');
    if(!apiScopeMatches(scope))throw new Error('HL_ERROR:errScope');
    const selected=selectWakeMicrophone(await navigator.mediaDevices.enumerateDevices(),config.input_device);
    if(!current()||!sameScope(scope,currentScope())||!apiScopeMatches(scope))throw new Error('HL_ERROR:errScope');
    if(activity.active||!['idle','error'].includes(controller.snapshot.status)||host.state.busy.get()||Object.values(host.state.busyBySession.get()).some(Boolean))throw new Error('HL_ERROR:errBusy');
    void playWakeCue(devices().output,ctx.storage.get('wake-cue-volume',1));
    ctx.storage.set('audio-devices',{...devices(),input:selected.deviceId});
    // Same provider as a named wake. The chat's saved Codex voice is reused; its saved selection is not changed.
    const saved=ctx.storage.get<Selection|null>(`selection:${scope.connection}:${scope.profile}`,null);
    const selection:Selection={provider:'codex',model:'gpt-live-1-codex',voice:saved?.provider==='codex'&&saved.voice?saved.voice:'cove'};
    // Goodbye names are frozen like a named wake: the profile's wake names, else its title and profile name.
    const names=config.generic?.names?.[scope.profile]?.filter(Boolean)??[];
    if(!names.length)names.push(scope.profile);
    callOwner=scope;owned=true;wakeNames=[...names];wakeCall=true;wakeGreeting={name:names[0]!,phrase:config.generic?.phrase??''};await controller.start(selection);
    if(controller.snapshot.status==='error')throw new Error(controller.snapshot.error);
   }catch(error){if(owned)stop();host.notify({kind:'error',message:localizeError(t,error instanceof Error?error.message:'HL_ERROR:errGeneric')});if(!owned&&!['idle','error'].includes(controller.snapshot.status))return;throw error}
  }
  wake=new WakeCoordinator({
   config:()=>ctx.rest<WakeConfig>('/wake/config'),
   control:(owner,action,eventId)=>ctx.rest<WakeStatus>('/wake/control',{method:'POST',body:{owner,action,...(eventId?{eventId}:{})},timeoutMs:20000}),
   local:()=>!host.state.connectionId.get()||host.state.connectionId.get()==='local',
   externalBusy:()=>activity.active,
   busy:()=>activity.active||!['idle','error'].includes(controller.snapshot.status)||host.state.busy.get()||Object.values(host.state.busyBySession.get()).some(Boolean),
   failed:error=>host.notify({kind:'error',message:localizeError(t,error instanceof Error?error.message:'HL_ERROR:errGeneric')}),
   start:startWake,startFocused,changed:()=>listeners.forEach(fn=>fn()),
  });
  ctx.onEvent('plugin.hermes-live.wake',event=>{if(event.payload)void wake.detected(event.payload as WakeEvent)});
  ctx.onEvent('voice.status',event=>{const value=event.payload as {enabled?:boolean;state?:string};activity.set('recorder',Boolean(value?.enabled)||(Boolean(value?.state)&&!['idle','off','stopped'].includes(value.state!)))});
  // Plugin-host push delivery is best-effort; bound fallback detection delay to one second.
  ctx.setInterval(()=>void wake.tick(),1000);
  let warming=false;
  const prewarm=async()=>{
   if(warming||!wake.enabled||(host.state.connectionId.get()&&host.state.connectionId.get()!=='local'))return;
   warming=true;
   try{await ctx.rest('/wake/prewarm',{method:'POST',timeoutMs:5000})}catch{/* Cold startup remains available. */}
   finally{warming=false}
  };
  ctx.setInterval(()=>void prewarm(),10000);
  ctx.onDispose(()=>void wake.dispose());

  ctx.onDispose(stop);
  ctx.setInterval(()=>ledger?.flush(),5000);
  ctx.setInterval(()=>{
   if(!callOwner)return;const now=currentScope();
   if(allowSessionAdopt&&!callOwner.session&&now.session&&callOwner.connection===now.connection&&callOwner.profile===now.profile)callOwner=now;
   if(!sameScope(callOwner,now)||!apiScopeMatches(callOwner)){stop();host.notify({kind:'info',message:t('scopeEnded')})}
  },250);

  const setupHref='/settings?tab=plugins&plugin=hermes-live:setup';
  const openSetup=()=>host.navigate(setupHref);
  let openCallSettings:(()=>void)|null=null;
  let booted=false;
  let stopSetupTest:(()=>Promise<void>)|null=null;
  const voiceMode=new VoicePause(ctx.storage.get('live-voice-paused',false),{
   persist:paused=>ctx.storage.set('live-voice-paused',paused),stop,
   release:async()=>{await stopSetupTest?.();await wake.park()},
   resume:async()=>{
    const scope=currentScope();
    if(!apiScopeMatches(scope))await host.ensureAgent(scope.connection==='local'?null:scope.connection,scope.profile);
    const ready=await ctx.rest<SetupState>('/setup',{timeoutMs:30000});
    // Explicit resume also unlocks setup repairs; missing setup never arms the mic.
    if(!basicReady(ready)){openSetup();return true}
    await wake.enable(true);
    if(wake.state==='suspended')throw new Error(wake.error||'HL_SETUP:failed');
    return true;
   },changed:()=>listeners.forEach(fn=>fn()),
  });
  const changeVoiceMode=async()=>{try{if(voiceMode.failed?voiceMode.intent==='resume':voiceMode.paused)await voiceMode.resume();else await voiceMode.pause()}catch{listeners.forEach(fn=>fn())}};
  function VoiceModeControls(){
   const {locale}=useLiveI18n();const c=setupCopy(locale);
   useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>`${voiceMode.paused}:${voiceMode.busy}:${voiceMode.failed}`);
   return <div style={{display:'grid',gap:8}}>
    <Button variant="secondary" disabled={voiceMode.busy} onClick={()=>void changeVoiceMode()}>{c(voiceMode.busy?(voiceMode.intent==='pause'?'pausingVoice':'resumingVoice'):voiceMode.failed?'refresh':voiceMode.paused?'resumeVoice':'pauseVoice')}</Button>
    <p role="status" style={{...hint,margin:0}}>{c(voiceMode.failed?(voiceMode.intent==='pause'?'pauseFailed':'resumeFailed'):voiceMode.paused&&!voiceMode.busy?'pausedHelp':'pauseHelp')}</p>
   </div>;
  }

  function SetupPage(){
   const profile=useSyncExternalStore(fn=>host.state.profile.subscribe(fn),()=>host.state.profile.get());
   const connection=useSyncExternalStore(fn=>host.state.connectionId.subscribe(fn),()=>host.state.connectionId.get());
   useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>`${voiceMode.paused}:${voiceMode.busy}`);
   return <><div style={{maxWidth:760,margin:'0 auto',padding:'16px 16px 0'}}><VoiceModeControls/></div><Setup suspended={voiceMode.paused||voiceMode.busy} registerStopTest={fn=>{stopSetupTest=fn;return()=>{if(stopSetupTest===fn)stopSetupTest=null}}} key={`${connection}:${profile}`} ctx={ctx} scopeKey={`${connection||'local'}:${profile}`} local={!connection||connection==='local'}
    subscribe={fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}}} callState={()=>controller.snapshot.status}
    active={()=>voiceMode.paused||voiceMode.busy||activity.active||!['idle','error'].includes(controller.snapshot.status)||host.state.busy.get()}
    hold={async()=>{const enabled=wake.enabled;await wake.enable(false);return()=>{if(enabled&&!voiceMode.paused&&!voiceMode.busy&&['idle','error'].includes(controller.snapshot.status))void wake.enable(true)}}}
    listening={()=>wake.enabled&&wake.state==='armed'} standby={async()=>{if(voiceMode.paused||voiceMode.busy)return false;await wake.enable(true);const deadline=Date.now()+90000;while(wake.enabled&&wake.state==='warming'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,500));await wake.tick()}if(voiceMode.paused)return false;if(wake.state!=='armed')throw new Error(wake.error||'HL_SETUP:modelStartFailed');return true}}
    trial={async target=>{if(voiceMode.paused||voiceMode.busy)throw new Error('HL_ERROR:errBusy');trialProfile=target;trialConnected=false;try{await wake.testCall(target)}catch(e){trialProfile=null;throw e}}} stop={stop}
    callSettings={()=>{host.navigate('/');queueMicrotask(()=>openCallSettings?.())}}/></>;
  }
  ctx.registerSettingsPage?.({id:'setup',title:'Hermes Live',icon:'unmute',render:()=> <SetupPage/>});
  function LiveButton(){
   const {t,locale}=useLiveI18n();
   const c=setupCopy(locale);
   useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>`${voiceMode.paused}:${voiceMode.busy}:${voiceMode.failed}`);
   useEffect(()=>{if(booted)return;booted=true;if(!voiceMode.paused&&ctx.storage.get('hands-free-enabled',false))void wake.enable(true).then(prewarm)},[]);
   const providerName=(id:Selection["provider"])=>id==="codex"?t("codexProvider"):providerNames[id];
   const wakeState=useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>`${wake.enabled}:${wake.state}`);
   const state=useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>controller.snapshot);
   const focusedOwner=useSyncExternalStore(fn=>host.state.focusedSessionOwner.subscribe(fn),()=>host.state.focusedSessionOwner.get());
   const scopeKey=`selection:${focusedOwner?.connectionId??''}:${focusedOwner?.profile??''}`;
   const savedSelection=()=>ctx.storage.get<Selection>(scopeKey,defaults);
   const [tab,setTab]=useState<'call'|'audio'|'wake'|'usage'>('call');const [deviceChoice,setDevices]=useState<AudioDevices>(devices);
   const [backend,setBackend]=useState('');
   const [open,setOpen]=useState(false);const [catalog,setCatalog]=useState<CatalogItem[]>([]);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
   const [draftSelection,setSelection]=useState<Selection>(savedSelection);const selection=state.selection??draftSelection;const [now,setNow]=useState(Date.now());const scroll=useRef<HTMLDivElement>(null);const mounted=useRef(true);const loadId=useRef(0);
   useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
   const active=!['idle','error'].includes(state.status);
   useEffect(()=>{const show=()=>{setTab('call');setOpen(true);void load()};openCallSettings=show;return()=>{if(openCallSettings===show)openCallSettings=null}},[scopeKey]);
   useEffect(()=>{++loadId.current;setSelection(savedSelection());setCatalog([]);setBackend('');setError('');setLoading(false);setOpen(false)},[scopeKey]);
   useEffect(()=>{if(state.status==='error'){setOpen(true);void load()}},[state.status]);
   useEffect(()=>{if(!active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[active]);
   useEffect(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight},[state.transcript]);
   const load=async()=>{
    const id=++loadId.current;setLoading(true);setError('');const scope=currentScope();
    try{
     if(!apiScopeMatches(scope)){
      if(!['idle','error'].includes(controller.snapshot.status)||activity.active||host.state.busy.get()||Object.values(host.state.busyBySession.get()).some(Boolean))throw new Error("HL_ERROR:errBusy");
      await host.ensureAgent(scope.connection==='local'?null:scope.connection,scope.profile);
     }
     if(!mounted.current||id!==loadId.current||!sameScope(scope,currentScope())||!apiScopeMatches(scope))return;
     const value=await ctx.rest<{providers:CatalogItem[];backend:string}>('/catalog',{timeoutMs:30000});
     if(!mounted.current||id!==loadId.current||!sameScope(scope,currentScope())||!apiScopeMatches(scope))return;
     setBackend(value.backend);setCatalog(value.providers);
     const saved=controller.snapshot.selection??savedSelection();
     const p=value.providers.find(x=>x.id===saved.provider)??value.providers[0];
     if(p)setSelection({provider:p.id,model:p.models.some(m=>m.id===saved.model)?saved.model:p.models[0]!.id,voice:p.voices.includes(saved.voice)?saved.voice:p.voices[0]!});
    }catch{if(mounted.current&&id===loadId.current)setError("HL_ERROR:errBackend")}
    finally{if(mounted.current&&id===loadId.current)setLoading(false)}
   };
   const updateDevices=async(value:AudioDevices)=>{
    const before=devices();setError('');
    try{
     if(value.input!==before.input&&(!host.state.connectionId.get()||host.state.connectionId.get()==='local')){
      const setup=await ctx.rest<SetupState>('/setup',{timeoutMs:30000});
      if(setup.enabled){
       const rows=await navigator.mediaDevices.enumerateDevices();
       const chosen=rows.find(d=>d.kind==='audioinput'&&d.deviceId===(value.input||'default'));
       const normalized=canonicalMicrophoneLabel;
       const matches=chosen?setup.audio.devices.filter(name=>normalized(name)===normalized(chosen.label)):[];
       if(matches.length!==1)throw new Error('HL_ERROR:errMicMissing');
       await ctx.rest('/setup',{method:'PUT',body:{device:matches[0]}});
      }
     }
     setDevices(value);ctx.storage.set('audio-devices',value);
    }catch(e){setError(e instanceof Error?e.message:'HL_ERROR:errAudio')}
   };
   const change=(next:Selection)=>{if(controller.snapshot.status==='error')controller.stop();setError('');setSelection(next);ctx.storage.set(scopeKey,next)};
   const configure=()=>{
    const scope=currentScope();
    if(!apiScopeMatches(scope)){setError('HL_ERROR:errScope');return}
    setOpen(false);host.navigate(settingsHref(scope.profile));
   };
   const start=async()=>{
    if(voiceMode.paused||voiceMode.busy||!['idle','error'].includes(controller.snapshot.status))return;
    setError('');setOpen(false);callOwner=currentScope();await controller.start(savedSelection());
   };
   const provider=catalog.find(p=>p.id===selection.provider);const seconds=state.startedAt?Math.floor((now-state.startedAt)/1000):0;
   const key=usageKey(currentScope());const usage=ledger&&ledgerKey===key?ledger.data:ctx.storage.get<UsageData>(key,emptyUsage());
   const readQuota=async()=>{const scope=currentScope();if(!apiScopeMatches(scope))throw new Error("HL_ERROR:errScope");const value=await ctx.rest<Quota>('/codex/usage',{timeoutMs:40000});if(!sameScope(scope,currentScope()))throw new Error("HL_ERROR:errScope");return value};
   const label=state.muted&&state.status==='listening'?t('muted'):{idle:t('idle'),connecting:t('preparing'),listening:t('listening'),speaking:t('speaking'),thinking:t('thinking'),error:t('errorStatus')}[state.status];
   const wakeLabel=voiceMode.paused?c(voiceMode.failed?(voiceMode.intent==='pause'?'pauseFailed':'resumeFailed'):'pausedVoice'):!wake.enabled?t('wakeOff'):wake.state==='armed'?t('wakeArmed',wake.config?.generic?[wake.config.phrase,wake.config.generic.phrase].filter(Boolean).join(', '):wake.config?.phrase??'…'):t(wake.state==='empty'?'wakeEmpty':wake.state==='warming'?'wakeWarming':wake.state==='calling'?'wakeCalling':wake.state==='rearming'?'wakeRearming':'wakeSuspended');
   const discStyle={height:primarySize,width:primarySize,padding:0,borderRadius:999,boxShadow:'0 2px 8px #0003'};
   return <span role="group" aria-label={t('call')} style={{order:1,display:'inline-flex',alignItems:'center',flexShrink:0}}>
    <HoverControls label={t('callSettings')} holdOpen={open} tip={active?t('actionTip',label,state.status==='connecting'?t('cancel'):t('end')):wakeLabel} primary={<Button type="button" variant={active?'default':'ghost'} size={active?'sm':'icon'} aria-label={active?(state.status==='connecting'?t('cancelConnection'):t('endCall')):t('wakeToggle')} aria-pressed={active||wake.enabled} aria-busy={state.status==='connecting'} disabled={voiceMode.busy} onClick={()=>{if(active)stop();else if(voiceMode.paused)void changeVoiceMode();else if(wake.enabled){ctx.storage.set('hands-free-enabled',false);void wake.enable(false)}else void (async()=>{try{const scope=currentScope();if(!apiScopeMatches(scope))await host.ensureAgent(scope.connection==='local'?null:scope.connection,scope.profile);const ready=await ctx.rest<SetupState>('/setup',{timeoutMs:30000});if(!basicReady(ready)){openSetup();return}ctx.storage.set('hands-free-enabled',true);await wake.enable(true);if(wake.state==='suspended')openSetup()}catch{openSetup()}})()}} style={{height:active?primarySize:controlSize,width:active?undefined:controlSize,padding:active?'0 12px':0,gap:6,borderRadius:999,color:!active&&wake.enabled?'var(--dt-primary-solid)':undefined}}>{active?<><CallWave state={state}/><span>{state.status==='connecting'?t('preparing'):t('end')}</span></>:<Icon name="wake"/>}</Button>
    }>
    {!active&&<Tip label={t('startTip',providerName(selection.provider),selection.voice)} placement="control"><Button type="button" variant="default" size="icon" aria-label={t('start')} disabled={voiceMode.paused||voiceMode.busy} onClick={()=>void start()} style={discStyle}><icons.AudioLines className={icons.iconSize.sm}/></Button></Tip>}
    <Tip label={c(voiceMode.paused?'resumeVoice':'pauseVoice')} placement="control"><Button type="button" variant="secondary" size="icon" disabled={voiceMode.busy} aria-label={c(voiceMode.failed?'refresh':voiceMode.paused?'resumeVoice':'pauseVoice')} onClick={()=>void changeVoiceMode()} style={discStyle}><Icon name={voiceMode.paused?'wake':'muted'}/></Button></Tip>
    {active&&<Tip label={state.muted?t('unmute'):t('mute')} placement="control"><Button type="button" variant={state.muted?'default':'secondary'} size="icon" aria-label={state.muted?t('unmute'):t('mute')} aria-pressed={state.muted} onClick={()=>controller.mute()} style={discStyle}><Icon name={state.muted?'muted':'mic'}/></Button></Tip>}
    <Popover open={open} onOpenChange={(v:boolean)=>{setOpen(v);if(v)void load()}}>
    <Tip label={t('settingsHint')} placement="control"><PopoverTrigger asChild><Button type="button" variant="secondary" size="icon" aria-label={t('callSettings')} style={discStyle}><Icon name="settings"/></Button></PopoverTrigger></Tip>
    {/* Keep default autofocus: Hermes focus-follow preserves focus inside overlays. */}
    <PopoverContent lang={locale} align="end" side="top" sideOffset={8} style={{width:'24rem',maxWidth:'calc(100vw - 24px)',padding:0,maxHeight:'min(40rem, var(--radix-popover-content-available-height, calc(100vh - 32px)))',display:'flex',flexDirection:'column'}}>
     <header style={{padding:16,display:'grid',gap:12,flexShrink:0,borderBottom:divider}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}><strong style={{fontSize:'.875rem'}}>{t('settings')}</strong><Button size="icon" variant="ghost" aria-label={t('close')} onClick={()=>setOpen(false)} style={{height:28,width:28}}><Icon name="close"/></Button></div>
      <VoiceModeControls/><div role="group" aria-label={t('callSettings')}><SegmentedControl className="w-full" value={tab} onChange={(value:'call'|'audio'|'wake'|'usage')=>setTab(value)} options={(['call','audio','wake','usage'] as const).map(id=>({id,label:t(id)}))}/></div>
     </header>
     <div style={{padding:16,minHeight:0,overflowY:'auto',display:'grid',gap:16}}>
     {tab==='audio'&&<>{error&&<p role="alert">{setupError(locale,error)||localizeError(t,error)}</p>}<DeviceSettings value={deviceChoice} active={active||voiceMode.paused||voiceMode.busy} onChange={value=>void updateDevices(value)}/></>}
     {tab==='wake'&&<><Button onClick={()=>{setOpen(false);openSetup()}}>{setupCopy(locale)('title')}</Button>{wake.error&&<p role="alert">{setupError(locale,wake.error)||localizeError(t,wake.error)}</p>}<p role="status" style={{...hint,margin:0}}>{wakeLabel}</p><WakeSettings key={scopeKey} rest={ctx.rest} changed={()=>void wake.tick()} local={!host.state.connectionId.get()||host.state.connectionId.get()==='local'}/><GenericWakeSettings key={`generic:${scopeKey}`} rest={ctx.rest} changed={()=>void wake.tick()} local={!host.state.connectionId.get()||host.state.connectionId.get()==='local'}/></>}
     {tab==='usage'&&<UsageSettings key={scopeKey} data={usage} selection={selection} readQuota={readQuota}/>}
     {tab==='call'&&<><Button variant="ghost" onClick={()=>{setOpen(false);openSetup()}}>{setupCopy(locale)('title')}</Button><div style={{display:'grid',gap:12}}>
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
   </Popover></HoverControls><span role="status" className="sr-only">{active?label:state.error?localizeError(t,state.error):wakeLabel}</span></span>;
  }
  ctx.register({id:'call',area:COMPOSER_AREAS.actions,order:20,render:()=> <LiveButton/>});
 }
};
