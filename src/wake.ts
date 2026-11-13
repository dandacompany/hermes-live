import type {DiagnosticFields} from './diagnostics.ts';
export interface WakeTarget {target:string;display_name:string;names:string[];phrases:string[]}
export interface WakeConfig {target:string;phrase:string;input_device:string;targets?:WakeTarget[];names?:string[]}
export interface WakeStatus {state:string;owned:boolean;eventId:string|null;target:string|null;selection?:WakeTarget|null}
export interface WakeEvent {owner:string;eventId:string;target:string}
interface Dependencies {
 diagnostic?:(event:string,fields:DiagnosticFields)=>void;
 config():Promise<WakeConfig>;
 control(owner:string,action:string,eventId?:string):Promise<WakeStatus>;
 local():boolean;busy():boolean;externalBusy?():boolean;
 start(config:WakeConfig,current:()=>boolean):Promise<void>;
 changed():void;failed?(error:unknown):void;
}
/** Serialized lease operations, with generation fences around asynchronous navigation. */
export class WakeCoordinator {
 readonly owner=crypto.randomUUID();enabled=false;state='off';config:WakeConfig|null=null;error='';
 private deps:Dependencies;private held=false;private handling=false;private ticking=false;
 private generation=0;private queue=Promise.resolve();private seen=new Set<string>();private due=0;private calling=false;
 constructor(deps:Dependencies){this.deps=deps}
 private trace(event:string,fields:DiagnosticFields){try{this.deps.diagnostic?.(event,{owner:this.owner,...fields})}catch{}}
 private set(state:string){if(this.state!==state)this.trace('wake.state',{state,enabled:this.enabled});this.state=state;this.deps.changed()}
 private command(action:string,eventId?:string){
  const result=this.queue.then(()=>this.deps.control(this.owner,action,eventId));
  this.queue=result.then(()=>{},()=>{});return result;
 }
 async enable(value:boolean){
  this.trace('wake.control',{action:value?'enable':'disable'});this.enabled=value;++this.generation;this.deps.changed();
  if(!value){const held=this.held;this.held=false;if(held)await this.command('release').catch(()=>{});this.set('off');return}
  await this.tick();
 }
 async tick(){
  if(!this.enabled||this.handling||this.ticking||Date.now()<this.due)return;
  if(!this.deps.local()){this.held=false;this.set('suspended');return}
  if(this.calling&&!this.held){this.set('calling');return}
  this.ticking=true;const generation=this.generation;
  try{
   // Revalidate configuration on the active profile, never borrow a remote route.
   const config=await this.deps.config();if(!this.enabled||generation!==this.generation)return;
   this.config=config;this.error='';
   if(config.targets?.length===0){if(this.held){await this.command('release');this.held=false}this.set('empty');return}
   const status=await this.command(this.held?'heartbeat':'arm');
   if(!this.enabled||generation!==this.generation){await this.command('release').catch(()=>{});return}
   this.held=true;
   if(this.deps.externalBusy?.()){await this.command('pause');this.set('blocked');return}
   if(this.calling){if(status.state==='armed')await this.command('pause');this.set('calling');return}
   if(status.eventId)await this.detected({owner:this.owner,eventId:status.eventId,target:status.target??config.target});
   else if(status.state==='paused'){await this.command('resume');this.set('armed')}
   else this.set(status.state);
  }catch(error){this.trace('wake.error',{reason:'control_failed'});this.error=error instanceof Error?error.message:String(error);if(this.held)await this.command('release').catch(()=>{});this.held=false;this.set('suspended')}
  finally{this.ticking=false}
 }
 async detected(event:WakeEvent){
  if(!this.enabled||this.handling||this.calling||!this.deps.local()||event.owner!==this.owner||!event.eventId||!(this.config?.targets?.some(t=>t.target===event.target)??event.target===this.config?.target)||this.seen.has(event.eventId))return;
  this.handling=true;const generation=this.generation;
  this.seen.add(event.eventId);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value!);
  const current=()=>this.enabled&&generation===this.generation&&this.deps.local();
  try{
   const claimed=await this.command('claim',event.eventId);if(!current())return;
   const selected=claimed.selection??this.config?.targets?.find(t=>t.target===event.target);
   if(this.config?.targets&&(!selected||selected.target!==event.target))throw new Error('Stale bot selection');
   const config=selected?{...this.config!,target:selected.target,phrase:selected.phrases[0]!,names:[...selected.names]}:this.config!;
   if(this.deps.busy()){await this.command('resume');this.set('armed');return}
   this.calling=true;this.set('calling');this.trace('navigation.start',{target:config.target,traceId:event.eventId});await this.deps.start(config,current);this.trace('navigation.end',{target:config.target,traceId:event.eventId,reason:current()?'connected':'cancelled'});
  }catch{this.trace('navigation.error',{reason:'start_failed',traceId:event.eventId});if(this.held)await this.command('release').catch(()=>{});this.calling=false;this.held=false;this.set('suspended')}
  finally{this.handling=false;if(!this.calling)this.due=Date.now()+2000}
 }
 /** Explicit setup trial: same navigation/call path, no synthetic wake event. */
 async testCall(target:string){
  if(this.handling||this.deps.busy()||!this.deps.local())throw new Error('HL_ERROR:errBusy');
  await this.enable(false);
  this.enabled=true;const generation=++this.generation;this.handling=true;
  const current=()=>this.enabled&&generation===this.generation&&this.deps.local();
  try{
   const config=await this.deps.config();if(!current())throw new Error('HL_ERROR:errScope');
   const selected=config.targets?.find(t=>t.target===target);if(!selected)throw new Error('HL_ERROR:errScope');
   this.config=config;this.calling=true;this.set('calling');
   await this.deps.start({...config,target,phrase:selected.phrases[0]!,names:[...selected.names]},current);
  }catch(error){this.calling=false;this.enabled=false;this.set('off');throw error}
  finally{this.handling=false}
 }
 /** A final or independently confirmed user command replaces the old call without a second mic listener. */
 async handoff(target:string,closePrevious:()=>Promise<void>,context:DiagnosticFields={}){
  if(!this.enabled||this.handling||!this.deps.local()){this.trace('navigation.error',{target,reason:!this.enabled?'disabled':this.handling?'already_handling':'remote'});return;}
  const traceId=crypto.randomUUID();this.trace('navigation.start',{...context,target,traceId});
  this.handling=true;const generation=this.generation;let starting=false;
  const current=()=>this.enabled&&generation===this.generation&&this.deps.local();
  try{
   await closePrevious();if(!current())return;
   // Finish any heartbeat against the departing backend before navigation changes REST scope.
   while(this.ticking&&current())await new Promise(r=>setTimeout(r,25));
   if(!current())return;
   const config=await this.deps.config();if(!current())return;
   const selected=config.targets?.find(row=>row.target===target);
   if(!selected)throw new Error('HL_ERROR:errScope');
   if(this.deps.busy())throw new Error('HL_ERROR:errBusy');
   this.config=config;this.calling=true;this.set('calling');starting=true;
   await this.deps.start({...config,target,phrase:selected.phrases[0]!,names:[...selected.names]},current);
   this.trace('navigation.end',{...context,target,traceId,reason:current()?'connected':'cancelled'});
  }catch(error){
   this.trace('navigation.error',{...context,target,traceId,reason:'handoff_failed'});
   if(this.held)await this.command('release').catch(()=>{});
   this.calling=false;this.held=false;this.set(this.enabled?'suspended':'off');
   if(!starting)this.deps.failed?.(error);
  }finally{this.handling=false;if(!this.calling)this.due=Date.now()+2000}
 }
 async releaseForNavigation(){
  // REST is profile scoped: release on the old backend before activating the target.
  if(this.held){await this.command('release');this.held=false}
 }
 /** A user pause must confirm release, including an arm already in flight. */
 async park(){
  this.enabled=false;this.calling=false;this.due=0;++this.generation;this.set('off');
  try{await this.command('release');this.held=false}
  catch(error){this.error=String(error);this.set('suspended');throw error}
 }
 async suspend(){
  if(!this.enabled)return;
  if(this.held)await this.command('pause');
  this.calling=true;this.set('calling');
 }
 ended(){this.calling=false;this.due=Date.now()+2000;this.set(this.enabled?'rearming':'off')}
 async dispose(){await this.enable(false)}
}

/** Independent activity sources must never clear one another's busy state. */
export class VoiceActivity {
 private values={native:false,recorder:false};private changed:(active:boolean)=>void;
 constructor(changed:(active:boolean)=>void){this.changed=changed}
 get active(){return this.values.native||this.values.recorder}
 set(source:'native'|'recorder',value:boolean){const before=this.active;this.values[source]=value;if(before!==this.active)this.changed(this.active)}
}
