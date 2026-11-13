import {WakeUtteranceGate,type WakeUtterance} from './wake-capture.ts';
export interface WakeVerification {candidateId:string;target:string|null;reason:string;elapsedMs?:number}
export interface WakeVerifyRequest {candidateId:string;target:string;pcm:Int16Array}
export type WakeCheckState=''|'checking'|'retry'|'unavailable';
interface Dependencies {
 target:(text:string)=>string|null;
 verify:(request:WakeVerifyRequest,signal:AbortSignal)=>Promise<WakeVerification>;
 commit:(text:string,candidateId:string)=>void;
 trace:(reason:string,fields:Record<string,string|number>)=>void;
 state:(state:WakeCheckState)=>void;
 now?:()=>number;
}
/** An acoustic utterance and the cloud delta command must agree before a handoff. */
export class WakeConfirmation {
 private deps:Dependencies;private gate:WakeUtteranceGate;
 private text='';private segment=0;private utterance:WakeUtterance|null=null;private lastDelta=0;private lastPcm=-Infinity;
 private generation=0;private attempt=false;private pending:AbortController|null=null;private pendingAt=0;
 constructor(deps:Dependencies){this.deps=deps;this.gate=new WakeUtteranceGate(id=>{this.clear('new_speech');this.segment=id},u=>{this.utterance=u},reason=>this.clear(reason))}
 private now(){return this.deps.now?.()??Date.now()}
 private clear(reason:string){
  ++this.generation;this.pending?.abort();if(this.pending)this.deps.trace(reason,{length:this.text.length});
  this.pending=null;this.utterance=null;this.text='';this.segment=0;this.attempt=false;this.deps.state('');
 }
 reset(reason='cancelled'){this.clear(reason);this.gate.reset();this.lastPcm=-Infinity}
 final(){this.reset('final_received')}
 pcm(frame:Int16Array|null){
  const now=this.now();if(!frame||now-this.lastPcm>600){this.reset('capture_gap');if(!frame)return}
  this.lastPcm=now;this.gate.feed(frame,now);
 }
 delta(text:string){
  if(!text||!this.segment)return;
  // An aborted check reached no verdict: let tick() verify the updated text once it settles.
  if(this.pending){this.pending.abort();this.pending=null;this.attempt=false;++this.generation;this.deps.trace('continued_speech',{length:this.text.length});this.deps.state('')}
  this.lastDelta=this.now();this.text+=text;
  if(this.text.length>128){this.clear('too_long');return}
 }
 tick(){
  const now=this.now();
  if(this.pending&&now-this.pendingAt>7000){this.reset('timeout');this.deps.state('retry');return}
  if(this.utterance&&now-this.utterance.endedAt>8000){this.reset('expired');return}
  if(this.pending||this.attempt||!this.utterance||now-this.lastDelta<350||now-this.lastPcm>400)return;
  const target=this.deps.target(this.text);if(!target)return;
  const generation=this.generation,segment=this.segment,text=this.text,candidateId=crypto.randomUUID();
  const abort=new AbortController();this.pending=abort;this.pendingAt=now;this.attempt=true;this.deps.state('checking');
  this.deps.trace('confirming',{traceId:candidateId,target,length:text.length});
  const request={candidateId,target,pcm:this.utterance.pcm};
  void this.deps.verify(request,abort.signal).then(result=>{
   if(abort.signal.aborted||generation!==this.generation||segment!==this.segment)return;
   this.pending=null;
   const current=this.now();
   if(!this.utterance||current-this.utterance.endedAt>8000||current-this.lastPcm>400||this.deps.target(this.text)!==target){this.reset('stale_result');return}
   this.deps.trace(result.reason,{traceId:candidateId,target,elapsedMs:result.elapsedMs??0,length:text.length});
   if(result.candidateId===candidateId&&result.target===target&&result.reason==='confirmed'){
    this.reset('consumed');this.deps.commit(text,candidateId);
   }else {this.utterance=null;this.deps.state(result.reason==='model_unavailable'?'unavailable':'retry')}
  }).catch(()=>{
   if(abort.signal.aborted||generation!==this.generation)return;
   this.pending=null;this.utterance=null;this.deps.trace('verification_failed',{traceId:candidateId,target});this.deps.state('unavailable');
  });
 }
}
