export interface Scope {connection:string;profile:string;session:string|null}
export interface Message {role:string;row_id?:number;text?:string;hidden?:boolean;display_kind?:string}
interface Dependencies {current:()=>Scope;busy:(id:string|null)=>boolean;history:(scope:Scope)=>Promise<Message[]>;submit:(session:string|null,text:string,context:string)=>boolean|string|Promise<boolean|string>;adopt?:(scope:Scope)=>void}
export function ownedScope(owner:{connectionId:string;profile:string}|null,session:string|null):Scope {
 return {connection:owner?.connectionId??'',profile:owner?.profile??'',session};
}
export function sameScope(a:Scope,b:Scope){return a.connection===b.connection&&a.profile===b.profile&&a.session===b.session}
export function resultAfter(rows:Message[],userRow:number):string|null {
 const start=rows.findIndex(x=>x.role==='user'&&x.row_id===userRow);if(start<0)return null;let result:string|null=null;
 for(const row of rows.slice(start+1)){if(row.role==='user')break;if(row.role==='assistant'&&row.text?.trim())result=row.text}return result;
}
function pause(signal:AbortSignal){return new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new Error("HL_ERROR:errCancelled"));return}const cancel=()=>{clearTimeout(timer);reject(new Error("HL_ERROR:errCancelled"))};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve()},500);signal.addEventListener('abort',cancel,{once:true})})}
export class HermesBridge {
 private deps:Dependencies;private running=false;
 constructor(deps:Dependencies){this.deps=deps}
 async run(text:string,signal:AbortSignal,context=''):Promise<string>{
  text=text.trim();if(!text)throw new Error("HL_ERROR:errRequest");
  if(this.running||this.deps.busy(this.deps.current().session))throw new Error("HL_ERROR:errBusy");
  this.running=true;const owner={...this.deps.current()};
  try{
   const before=owner.session?await this.deps.history(owner):[];const ids=new Set(before.map(x=>x.row_id));
   if(signal.aborted||!sameScope(owner,this.deps.current()))throw new Error("HL_ERROR:errScope");
   const submitted=await this.deps.submit(owner.session,text,context);
   if(!submitted)throw new Error("HL_ERROR:errBackend");
   if(typeof submitted==='string')text=submitted;
   const deadline=Date.now()+180000;let userRow:number|undefined;
   while(Date.now()<deadline){
    await pause(signal);const now=this.deps.current();
    if(!owner.session&&now.session&&owner.connection===now.connection&&owner.profile===now.profile){owner.session=now.session;this.deps.adopt?.({...owner})}
    if(!sameScope(owner,now))throw new Error("HL_ERROR:errScope");
    if(!owner.session)continue;
    const rows=await this.deps.history(owner);
    if(signal.aborted||!sameScope(owner,this.deps.current()))throw new Error("HL_ERROR:errScope");
    if(userRow===undefined)userRow=rows.find(x=>x.role==='user'&&x.text===text&&x.row_id!==undefined&&!ids.has(x.row_id))?.row_id;
    if(userRow!==undefined&&!this.deps.busy(owner.session)){const result=resultAfter(rows,userRow);if(result)return result}
   }
   throw new Error("HL_ERROR:errTimeout");
  }finally{this.running=false}
 }
}
