export type DiagnosticFields=Record<string,string|number|boolean>;
export interface DiagnosticRow {id:string;at:number;event:string;profile:string;[key:string]:unknown}
export interface DiagnosticReport {version:number;now:number;profile:string;detailUntil:number;detailId:string;events:DiagnosticRow[];details:DiagnosticRow[];last:Record<string,DiagnosticRow>;writeError:boolean}
interface Entry {event:string;fields:DiagnosticFields;at:number;text?:string;detailId?:string}
/** A bounded queue per backend scope; late events never cross into another profile. */
interface Deps {scope:()=>string;send:(events:Entry[])=>Promise<unknown>;now?:()=>number}
export class Diagnostics {
 private deps:Deps;
 private queue:Entry[]=[];private busy=false;private scope='';private detailId='';private until=0;private last=new Map<string,number>();dropped=0;failed=false;
 constructor(deps:Deps){this.deps=deps}
 private now(){return this.deps.now?.()??Date.now()}
 private sync(){const scope=this.deps.scope();if(this.scope!==scope){if(this.scope.slice(0,this.scope.lastIndexOf(':'))!==scope.slice(0,scope.lastIndexOf(':'))){this.dropped+=this.queue.length;this.queue=[]}else for(const e of this.queue){delete e.text;delete e.detailId}this.scope=scope;this.detailId='';this.until=0;this.last.clear()}}
 consent(report:DiagnosticReport){this.sync();if(report.profile&&this.scope.split(':').at(-1)!==report.profile)return;this.detailId=report.detailId;this.until=report.detailUntil*1000}
 event(event:string,fields:DiagnosticFields={},text?:string){
  this.sync();const at=this.now();const entry:Entry={event,fields:{...fields,origin:this.scope.split(':').at(-1)||'default'},at};
  if(text&&at<this.until&&this.detailId){entry.text=text.slice(0,500);entry.detailId=this.detailId}
  if(this.queue.length>=200){this.queue.shift();this.dropped++}this.queue.push(entry);
 }
 sampled(event:string,fields:DiagnosticFields,ms=10000){this.sync();const now=this.now();if(now-(this.last.get(event)??-Infinity)<ms)return;this.last.set(event,now);this.event(event,fields)}
 async flush(){
  this.sync();if(this.busy||!this.queue.length)return;this.busy=true;const batch=this.queue.splice(0,50);
  // Discard queued speech as soon as consent expires, even before the backend checks it.
  if(this.now()>=this.until)for(const entry of batch){delete entry.text;delete entry.detailId}
  try{const result=await this.deps.send(batch) as {writeError?:boolean}|undefined;this.failed=Boolean(result?.writeError)}catch{this.dropped+=batch.length;this.failed=true}finally{this.busy=false}
 }
}
