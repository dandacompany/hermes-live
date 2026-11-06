/** Explicit user ownership switch. It never infers another app's microphone state. */
export class VoicePause {
 paused:boolean;busy=false;failed=false;intent:'pause'|'resume'='pause';
 private deps:{persist:(paused:boolean)=>void;stop:()=>void;release:()=>Promise<void>;resume:()=>Promise<boolean>;changed:()=>void};
 constructor(paused:boolean,deps:VoicePause['deps']){this.paused=paused;this.deps=deps}
 async pause(){
  if(this.busy)return;
  this.intent='pause';this.paused=true;this.busy=true;this.failed=false;this.deps.changed();
  try{this.deps.stop();this.deps.persist(true);await this.deps.release()}
  catch(e){this.failed=true;throw e}
  finally{this.busy=false;this.deps.changed()}
 }
 async resume(){
  if(this.busy)return false;
  this.intent='resume';this.busy=true;this.failed=false;this.deps.changed();
  try{
   if(!await this.deps.resume())return false;
   this.paused=false;this.deps.persist(false);return true;
  }catch(e){this.paused=true;this.failed=true;this.deps.stop();await this.deps.release().catch(()=>{});throw e}
  finally{this.busy=false;this.deps.changed()}
 }
}
