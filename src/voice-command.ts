// External voice-call control (hermes://hermes-live/voice?action=…&profile=…&nonce=…).
// Pure decision logic: no SDK, microphone or wake dependencies.
export type VoiceAction='start'|'stop'|'toggle';
export interface VoiceCommand {action:VoiceAction;profile:string;nonce:string}
export type CallPhase='off'|'connecting'|'in_call'|'unknown';
export type RejectReason='bad_request'|'bad_token'|'auth_unavailable'|'duplicate'|'too_soon'|'remote'|'transitioning'|'unknown'|'already_on'|'already_off'|'paused'|'busy'|'no_chat'|'wrong_bot'|'scope_changed'|'start_failed';
export interface FocusedChat {connection:string;profile:string;storedId:string|null}
export interface GateContext {local:boolean;status:string;callProfile:string|null;focused:FocusedChat|null;paused:boolean;transitioning:boolean;busy:boolean}
export type Decision={ok:true;op:'start'|'stop'}|{ok:false;reason:RejectReason};
export interface LastCommand {nonce:string|null;action:VoiceAction|null;profile:string|null;outcome:'accepted'|'rejected'|'failed';reason:RejectReason|null;at:number}
export interface VoiceReport {v:1;instance:string;status:CallPhase;profile:string|null;last:LastCommand|null}

const ACTIONS=new Set<string>(['start','stop','toggle']);
const PROFILE=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const NONCE=/^[A-Za-z0-9_-]{8,64}$/;
// voice-token file: one line of 43 base64url characters (32 random bytes).
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
export const START_RETURN_TIMEOUT_MS=4000;

function param(location:string,key:string){
 const at=location.indexOf('?');if(at<0)return null;
 const values=new URLSearchParams(location.slice(at+1)).getAll(key);return values.length===1?values[0]!:null;
}

export function parseVoiceToken(location:string):string|null{const token=param(location,'token');return token&&TOKEN.test(token)?token:null}

/** Same location minus the token, for scrubbing the history entry. */
export function withoutVoiceToken(location:string):string{
 const at=location.indexOf('?');if(at<0)return location;
 const params=new URLSearchParams(location.slice(at+1));params.delete('token');
 const rest=params.toString();return rest?`${location.slice(0,at)}?${rest}`:location.slice(0,at);
}

/** Page identity: a new nonce remounts the command page; scrubbing the token does not. */
export function voiceCommandKey(location:string):string{return param(location,'nonce')??''}

export function parseVoiceCommand(location:string):VoiceCommand|null{
 const one=(key:string)=>param(location,key);
 const action=one('action'),profile=one('profile'),nonce=one('nonce');
 if(!action||!ACTIONS.has(action)||!profile||!PROFILE.test(profile)||!nonce||!NONCE.test(nonce))return null;
 return {action:action as VoiceAction,profile,nonce};
}

export function callPhase(status:string):CallPhase{
 if(status==='idle'||status==='error')return 'off';
 if(status==='connecting')return 'connecting';
 if(status==='listening'||status==='speaking'||status==='thinking')return 'in_call';
 return 'unknown';
}

export class VoiceCommandGate {
 private seen:string[]=[];private lastAt=-Infinity;private minIntervalMs:number;private memory:number;
 constructor(minIntervalMs=1500,memory=128){this.minIntervalMs=minIntervalMs;this.memory=memory}
 decide(command:VoiceCommand|null,ctx:GateContext,now:number):Decision{
  const no=(reason:RejectReason):Decision=>({ok:false,reason});
  if(!command)return no('bad_request');
  if(this.seen.includes(command.nonce))return no('duplicate');
  this.seen.push(command.nonce);if(this.seen.length>this.memory)this.seen.shift();
  const previous=this.lastAt;this.lastAt=now;
  if(now-previous<this.minIntervalMs)return no('too_soon');
  if(!ctx.local)return no('remote');
  const phase=callPhase(ctx.status);
  if(phase==='unknown')return no('unknown');
  if(phase==='connecting'||ctx.transitioning)return no('transitioning');
  const op=command.action==='toggle'?(phase==='in_call'?'stop':'start'):command.action;
  if(op==='stop'){
   if(phase==='off')return no('already_off');
   return ctx.callProfile===command.profile?{ok:true,op}:no('wrong_bot');
  }
  if(phase==='in_call')return no('already_on');
  if(ctx.paused)return no('paused');
  if(ctx.busy)return no('busy');
  if(!ctx.focused?.storedId)return no('no_chat');
  if(ctx.focused.connection!=='local')return no('remote');
  return ctx.focused.profile===command.profile?{ok:true,op}:no('wrong_bot');
 }
}

export interface RunnerDeps {
 gate:VoiceCommandGate;now:()=>number;context:()=>GateContext;verify:(token:string)=>Promise<boolean>;
 stop:()=>void;start:(focused:FocusedChat)=>Promise<void>;
 returnTo:(storedId:string|null)=>void;waitFocused:(focused:FocusedChat,timeoutMs:number)=>Promise<boolean>;
 record:(last:LastCommand)=>void;
}

export async function runVoiceCommand(deps:RunnerDeps,location:string):Promise<LastCommand>{
 const command=parseVoiceCommand(location);const ctx=deps.context();const at=deps.now();
 const finish=(outcome:LastCommand['outcome'],reason:RejectReason|null)=>{
  const last:LastCommand={nonce:command?.nonce??null,action:command?.action??null,profile:command?.profile??null,outcome,reason,at};
  deps.record(last);return last;
 };
 const back=ctx.focused?.storedId??null;
 const reject=(reason:RejectReason)=>{deps.returnTo(back);return finish('rejected',reason)};
 // Authenticate before the gate: unauthenticated links must not burn nonces or the rate limit,
 // and a remote backend must never receive the local token.
 if(!command)return reject('bad_request');
 const token=parseVoiceToken(location);
 if(!token)return reject('bad_token');
 if(!ctx.local)return reject('remote');
 let valid:boolean;
 try{valid=await deps.verify(token)}catch{return reject('auth_unavailable')}
 if(!valid)return reject('bad_token');
 const decision=deps.gate.decide(command,ctx,at);
 if(!decision.ok)return reject(decision.reason);
 if(decision.op==='stop'){deps.stop();deps.returnTo(back);return finish('accepted',null)}
 const focused=ctx.focused!;
 // Leave the command page before starting so the call is owned by the chat itself.
 deps.returnTo(back);
 if(!await deps.waitFocused(focused,START_RETURN_TIMEOUT_MS))return finish('rejected','scope_changed');
 const accepted=finish('accepted',null);
 try{await deps.start(focused);return accepted}catch{return finish('failed','start_failed')}
}

export function voiceReport(status:string,callProfile:string|null,last:LastCommand|null,instance:string):VoiceReport{
 const phase=callPhase(status);
 return {v:1,instance,status:phase,profile:phase==='connecting'||phase==='in_call'?callProfile:null,last};
}
