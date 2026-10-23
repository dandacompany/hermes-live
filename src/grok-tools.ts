// A response may announce several calls before its final response.done frame.
// Generation resumes only when every announced call has a submitted output.
export class GrokToolTurns {
 private turns=new Map<string,{calls:Set<string>;outputs:Set<string>;done:boolean}>();
 private owners=new Map<string,string>();
 observe(message:any){
  const response=message.response;const id=message.response_id??response?.id;
  if(typeof id!=='string')return;
  const turn=this.turns.get(id)??{calls:new Set<string>(),outputs:new Set<string>(),done:false};
  this.turns.set(id,turn);
  const add=(call:any)=>{if(call?.type==='function_call'&&typeof call.call_id==='string'){turn.calls.add(call.call_id);this.owners.set(call.call_id,id)}};
  add(message.item);
  if(message.type==='response.function_call_arguments.done')add({type:'function_call',call_id:message.call_id});
  if(message.type==='response.done'){
   for(const item of response?.output??[])add(item);
   turn.done=true;
   if(!turn.calls.size)this.turns.delete(id);
  }
 }
 output(id:string){const owner=this.owners.get(id);if(owner)this.turns.get(owner)?.outputs.add(id)}
 takeReady():number {
  let count=0;
  for(const [id,turn] of this.turns){if(turn.done&&turn.calls.size&&[...turn.calls].every(call=>turn.outputs.has(call))){count++;this.turns.delete(id);for(const call of turn.calls)this.owners.delete(call)}}
  return count;
 }
}
