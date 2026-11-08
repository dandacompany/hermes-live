import type {DiagnosticFields} from './diagnostics.ts';
import {isGoodbye,GoodbyeDetector} from './goodbye.ts';
import {audioDeviceError} from './devices.ts';
import {spokenDelegation,type SpokenFragment} from './context.ts';
import type {AudioPort,Connection,LiveEvent,Selection,Transport} from './types.ts';
export interface CallState {status:'idle'|'connecting'|'listening'|'speaking'|'thinking'|'error';selection:Selection|null;muted:boolean;level:number;startedAt:number;error:string;transcript:{speaker:'user'|'assistant';text:string}[]}
interface Dependencies {diagnostic?:(event:string,fields:DiagnosticFields,text?:string)=>void;voiceControl?:(text:string,context?:DiagnosticFields)=>boolean;isVoiceControl?:(text:string)=>boolean;goodbye?:()=>boolean;goodbyeNames?:()=>readonly string[];usage?:(event:LiveEvent)=>void;connected?:(selection:Connection)=>void;ended?:()=>void;prepare?:(signal:AbortSignal,selection:Selection)=>Promise<void>;audio:(speaking:(v:boolean)=>void,selection:Selection)=>AudioPort;token:(selection:Selection)=>Promise<Connection>;transport:(config:Connection,emit:(e:LiveEvent)=>void,audio:AudioPort)=>Transport;delegate:(text:string,signal:AbortSignal,voiceContext:string)=>Promise<string>;changed:(state:CallState)=>void}
export class CallController {
 snapshot:CallState={status:'idle',selection:null,muted:false,level:0,startedAt:0,error:'',transcript:[]};
 private callId='';private inputAt=0;private partialAt=0;
 private trace(event:string,fields:DiagnosticFields={},text?:string){try{this.deps.diagnostic?.(event,{callId:this.callId,...fields},text)}catch{}}
 private goodbyeDetector=new GoodbyeDetector();
 private completedUserTurns=new Set<string>();private deps:Dependencies;private generation=0;private abort:AbortController|null=null;private audio:AudioPort|null=null;private transport:Transport|null=null;private seen=new Set<string>();private cancelled=new Set<string>();private busy=false;private lastMeter=0;private spoken:SpokenFragment[]=[];
 constructor(deps:Dependencies){this.deps=deps}
 private set(update:Partial<CallState>){this.snapshot={...this.snapshot,...update};this.deps.changed(this.snapshot)}
 async start(selection:Selection){
  if(this.abort)return;this.callId=crypto.randomUUID();this.inputAt=this.partialAt=0;this.trace('call.start',{provider:selection.provider});selection={...selection};const generation=++this.generation;const abort=new AbortController();this.abort=abort;this.seen.clear();this.cancelled.clear();this.busy=false;this.spoken=[];this.completedUserTurns.clear();this.goodbyeDetector.reset();
  this.set({status:'connecting',selection:{...selection},error:'',muted:false,transcript:[],startedAt:0,level:0});
  const current=()=>this.generation===generation&&!abort.signal.aborted;
  try{
   await this.deps.prepare?.(abort.signal,selection);if(!current())return;
   const audio=this.deps.audio(speaking=>{if(current()&&this.snapshot.status!=='connecting')this.set({status:this.busy?'thinking':speaking?'speaking':'listening'})},selection);this.audio=audio;
   const opening=audio.open(selection.provider==='gemini'?16000:['codex','qwen'].includes(selection.provider)?48000:24000,abort.signal,(data,level)=>{if(!current())return;this.transport?.audio(data);if(Date.now()-this.lastMeter>80){this.lastMeter=Date.now();this.set({level});if(Date.now()-this.inputAt>=10000){this.inputAt=Date.now();this.trace('audio.sample',{level,muted:this.snapshot.muted,source:'call'})}}});
   // Auth/scope preflight has finished; microphone setup and history/token lookup are independent.
   const [,config]=await Promise.all([opening,this.deps.token(selection)]);
   if(!current()){audio.close();return}
   const transport=this.deps.transport(config,event=>{if(current())this.event(event,generation,abort.signal)},audio);this.transport=transport;
   await transport.open();if(!current()){transport.close();return}
   this.deps.connected?.(config);this.trace('call.connected',{provider:selection.provider});
   this.set({status:'listening',startedAt:Date.now()});
  }catch(error){if(current())this.fail(audioDeviceError(error))}
 }
 private event(event:LiveEvent,generation:number,signal:AbortSignal){
  try{
   if(event.type==='diagnostic'){this.trace(event.event,event.fields);return}
   if(event.type==='usage'||event.type==='audioUsage'){this.deps.usage?.(event);return}
   if(event.type==='error'){this.fail(event.message);return}
   if(event.type==='audio'){this.audio?.play(event.data,event.rate);return}
   if(event.type==='interrupt'){this.audio?.interrupt();return}
   if(event.type==='cancelTools'){event.ids.forEach(id=>this.cancelled.add(id));return}
   if(event.type==='userTurnEnd'){
    const turnId=event.id??crypto.randomUUID();
    if(event.id&&this.completedUserTurns.has(event.id)){this.trace('transcript.final',{turnId,reason:'duplicate',length:event.text.length});return}
    this.trace('transcript.final',{turnId,length:event.text.length},event.text);
    if(event.id){this.completedUserTurns.add(event.id);if(this.completedUserTurns.size>128)this.completedUserTurns.delete(this.completedUserTurns.values().next().value!)}
    if(this.deps.voiceControl?.(event.text,{callId:this.callId,turnId})){this.goodbyeDetector.reset();return;}
    const enabled=Boolean(this.deps.goodbye?.());const matched=enabled&&this.goodbyeDetector.accept(event.text,this.deps.goodbyeNames?.()??['루미','Lumi']);this.trace('command.goodbye',{turnId,reason:!enabled?'disabled':matched?'matched':'no_match'});if(matched)this.stop();return;
   }
   if(event.type==='transcript'){
    if(event.speaker==='user'&&Date.now()-this.partialAt>=1000){this.partialAt=Date.now();this.trace('transcript.partial',{length:event.text.length})}
    this.spoken.push({speaker:event.speaker,text:event.text.slice(-6000),at:Date.now()});this.spoken=this.spoken.slice(-80);
    const transcript=this.snapshot.transcript.map(x=>({...x}));const last=transcript.at(-1);
    if(last?.speaker===event.speaker)last.text=(last.text+event.text).slice(-6000);else transcript.push({speaker:event.speaker,text:event.text});this.set({transcript:transcript.slice(-50)});return;
   }
   if(event.type!=='tool'||this.seen.has(event.id))return;
   if(this.deps.isVoiceControl?.(event.request)||(this.deps.goodbye?.()&&isGoodbye(event.request,this.deps.goodbyeNames?.()))){this.transport?.toolResult(event.id,'Voice controls are handled locally.');return;}this.seen.add(event.id);
   if(event.name!=='ask_hermes'||!event.request.trim()){this.transport?.toolResult(event.id,"The task request is unsupported or empty.");return}
   if(this.busy){this.transport?.toolResult(event.id,"Hermes is processing an earlier request. Wait for it to finish.");return}
   this.busy=true;this.set({status:'thinking'});
   const delegation=spokenDelegation(event.request,this.spoken);
   void this.deps.delegate(delegation.prompt,signal,delegation.context).catch(()=> "Hermes could not complete the task. Check the chat status.").then(result=>{
    if(this.generation!==generation||signal.aborted)return;
    this.busy=false;this.set({status:'listening'});
    if(!this.cancelled.has(event.id))this.transport?.toolResult(event.id,result.slice(0,24000));
   });
  }catch{this.fail("HL_ERROR:errAudio")}
 }
 mute(){const muted=!this.snapshot.muted;this.audio?.mute(muted);this.set({muted,level:0})}
 private fail(message:string){this.trace('call.error',{reason:message.startsWith('HL_ERROR:')?message:'provider_or_audio_error'});this.stop();this.set({status:'error',error:message})}
 stop(){this.goodbyeDetector.reset();const wasActive=Boolean(this.abort);if(wasActive)this.trace('call.end');++this.generation;this.abort?.abort();this.abort=null;const transport=this.transport,audio=this.audio;this.transport=null;this.audio=null;try{transport?.close()}catch{}finally{try{audio?.close()}catch{}}this.busy=false;this.set({status:'idle',selection:null,muted:false,level:0,startedAt:0,error:''});if(wasActive)this.deps.ended?.()}
}
