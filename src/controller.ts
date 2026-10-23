import {audioDeviceError} from './devices.ts';
import {spokenDelegation,type SpokenFragment} from './context.ts';
import type {AudioPort,Connection,LiveEvent,Selection,Transport} from './types.ts';
export interface CallState {status:'idle'|'connecting'|'listening'|'speaking'|'thinking'|'error';selection:Selection|null;muted:boolean;level:number;startedAt:number;error:string;transcript:{speaker:'user'|'assistant';text:string}[]}
interface Dependencies {usage?:(event:LiveEvent)=>void;connected?:(selection:Connection)=>void;ended?:()=>void;prepare?:(signal:AbortSignal,selection:Selection)=>Promise<void>;audio:(speaking:(v:boolean)=>void,selection:Selection)=>AudioPort;token:(selection:Selection)=>Promise<Connection>;transport:(config:Connection,emit:(e:LiveEvent)=>void,audio:AudioPort)=>Transport;delegate:(text:string,signal:AbortSignal,voiceContext:string)=>Promise<string>;changed:(state:CallState)=>void}
export class CallController {
 snapshot:CallState={status:'idle',selection:null,muted:false,level:0,startedAt:0,error:'',transcript:[]};
 private deps:Dependencies;private generation=0;private abort:AbortController|null=null;private audio:AudioPort|null=null;private transport:Transport|null=null;private seen=new Set<string>();private cancelled=new Set<string>();private busy=false;private lastMeter=0;private spoken:SpokenFragment[]=[];
 constructor(deps:Dependencies){this.deps=deps}
 private set(update:Partial<CallState>){this.snapshot={...this.snapshot,...update};this.deps.changed(this.snapshot)}
 async start(selection:Selection){
  if(this.abort)return;selection={...selection};const generation=++this.generation;const abort=new AbortController();this.abort=abort;this.seen.clear();this.cancelled.clear();this.busy=false;this.spoken=[];
  this.set({status:'connecting',selection:{...selection},error:'',muted:false,transcript:[],startedAt:0,level:0});
  const current=()=>this.generation===generation&&!abort.signal.aborted;
  try{
   await this.deps.prepare?.(abort.signal,selection);if(!current())return;
   const audio=this.deps.audio(speaking=>{if(current()&&this.snapshot.status!=='connecting')this.set({status:this.busy?'thinking':speaking?'speaking':'listening'})},selection);this.audio=audio;
   await audio.open(selection.provider==='gemini'?16000:['codex','qwen'].includes(selection.provider)?48000:24000,abort.signal,(data,level)=>{if(!current())return;this.transport?.audio(data);if(Date.now()-this.lastMeter>80){this.lastMeter=Date.now();this.set({level})}});
   if(!current()){audio.close();return}
   const config=await this.deps.token(selection);if(!current()){audio.close();return}
   const transport=this.deps.transport(config,event=>{if(current())this.event(event,generation,abort.signal)},audio);this.transport=transport;
   await transport.open();if(!current()){transport.close();return}
   this.deps.connected?.(config);
   this.set({status:'listening',startedAt:Date.now()});
  }catch(error){if(current())this.fail(audioDeviceError(error))}
 }
 private event(event:LiveEvent,generation:number,signal:AbortSignal){
  try{
   if(event.type==='usage'||event.type==='audioUsage'){this.deps.usage?.(event);return}
   if(event.type==='error'){this.fail(event.message);return}
   if(event.type==='audio'){this.audio?.play(event.data,event.rate);return}
   if(event.type==='interrupt'){this.audio?.interrupt();return}
   if(event.type==='cancelTools'){event.ids.forEach(id=>this.cancelled.add(id));return}
   if(event.type==='transcript'){
    this.spoken.push({speaker:event.speaker,text:event.text.slice(-6000),at:Date.now()});this.spoken=this.spoken.slice(-80);
    const transcript=this.snapshot.transcript.map(x=>({...x}));const last=transcript.at(-1);
    if(last?.speaker===event.speaker)last.text=(last.text+event.text).slice(-6000);else transcript.push({speaker:event.speaker,text:event.text});this.set({transcript:transcript.slice(-50)});return;
   }
   if(event.type!=='tool'||this.seen.has(event.id))return;this.seen.add(event.id);
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
 private fail(message:string){this.stop();this.set({status:'error',error:message})}
 stop(){this.deps.ended?.();++this.generation;this.abort?.abort();this.abort=null;this.transport?.close();this.transport=null;this.audio?.close();this.audio=null;this.busy=false;this.set({status:'idle',selection:null,muted:false,level:0,startedAt:0,error:''})}
}
