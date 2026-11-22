import type {Route,OpenSessionOptions} from '@hermes/plugin-sdk';
import type {Scope} from './hermes-bridge.ts';
/** Stored identity selects the Bot Chat; runtime identity authorizes the call. */
export function wakeBotReady(scope:Scope,target:string,connection:string,expectedStored:string,focusedStored:string|null){
 return scope.profile===target&&scope.connection===connection&&Boolean(scope.session)&&focusedStored===expectedStored;
}
interface Navigation {
 activate?(route:Route):Promise<void>;
 retain?(route:Route):Promise<()=>void>;
 isSelected(stored:string,route:Route):boolean;
 request<T>(route:Route,method:string,params:Record<string,unknown>):Promise<T>;
 revealPane?(id:string):void;
 paneVisible?(id:string):boolean;
 label?(owner:string,name:string):void;
 openSession?(id:string,options:OpenSessionOptions):Promise<void>;
}
interface BotChat {id:string;resolved_id?:string;title?:string;root_title?:string;message_count?:number;live_message_count?:number}
/** Use the same exact-title registry as a Bots row click; never a remembered side thread. */
export async function openWakeBot(deps:Navigation & {routes():Promise<Route[]>;activate(route:Route):Promise<void>},target:string,connection:string,name:string,current:()=>boolean):Promise<string>{
 const check=()=>{if(!current())throw new Error('HL_ERROR:errScope')};
 const routes=await deps.routes();check();
 const route=routes.find(r=>r.profile===target&&r.connectionId===connection&&r.mode!=='remote');
 if(!route)throw new Error('HL_ERROR:errScope');
 return openCanonicalBot(deps,route,name,current);
}

export async function openCanonicalBot(deps:Navigation,route:Route,name:string,current:()=>boolean):Promise<string>{
 const target=route.profile;
 const check=()=>{if(!current())throw new Error('HL_ERROR:errScope')};
 check();
 if(!deps.revealPane||!deps.paneVisible||!deps.openSession)throw new Error('HL_ERROR:errBotsView');
 deps.revealPane('hermes-bots:pane');check();
 if(!deps.paneVisible('hermes-bots:pane'))throw new Error('HL_ERROR:errBotsView');
 const profile=route.targetProfile||target;
 const lookup=async()=>{
  const result=await deps.request<{sessions:BotChat[]}>(route,'session.list',{profile,title:'Bot Chat',include_hidden:true,limit:200});check();
  if(!Array.isArray(result?.sessions)||result.sessions.length>1)throw new Error('HL_ERROR:errScope');
  const row=result.sessions[0];
  if(result.sessions.length&&(!row||typeof row.id!=='string'||!row.id||(row.root_title||row.title)!=='Bot Chat'))throw new Error('HL_ERROR:errScope');
  return row;
 };
 let row=await lookup();
 let stored:string|undefined=row?.resolved_id||row?.id;
 if(!stored){
  // A secondary gateway releases lazy runtime sessions when its last request lease closes.
  const release=await deps.retain?.(route);
  try{
   check();
   const created=await deps.request<{stored_session_id?:string;session_id?:string;info?:{desktop_contract?:unknown}}>(route,'session.create',{profile,title:'Bot Chat',hidden:true,follow_profile_config:true});check();
   stored=created.stored_session_id;
   // The TUI gateway returns a lazy draft. Its explicit title RPC persists the hidden row.
   // A simultaneous creator may already own the title, in which case the registry wins.
   if(created.info?.desktop_contract!=null){
    if(!stored||!created.session_id)throw new Error('HL_ERROR:errScope');
    try{await deps.request(route,'session.title',{session_id:created.session_id,title:'Bot Chat'})}
    catch(error){if(!/already in use/i.test(String((error as {message?:string})?.message??'')))throw error}
    check();
    row=await lookup();
    stored=row?.resolved_id||row?.id;
   }
  }finally{release?.()}
 }
 if(typeof stored!=='string'||!stored)throw new Error('HL_ERROR:errScope');
 if(deps.activate){await deps.activate(route);check()}
 const owner=`bot:${route.connectionId}::${route.profile}`;
 deps.label?.(owner,name||target);
 const open=(refresh=false)=>deps.openSession!(stored!,{...(refresh?{refreshInPlace:true}:{}),...(route.mode==='remote'?{route}:{}),profile:target,intent:route.mode==='remote'?'main':'in-place',workspaceMode:'bots',workspaceOwnerKey:owner,
  tabTitle:'Bot Chat',keepAllProfilesScope:true,awaitHydration:true,forceResume:true,
  expectHistory:(row?.live_message_count??row?.message_count??0)>0,hydrationTimeoutMs:60000,retryHydrationTimeoutOnce:true});
 try{await open()}catch(error){
  // Bots can restore its sidebar owner after the SDK has opened the requested chat.
  // Retry that same stored chat once, only while its owner/selection remains exact.
  if(!(error instanceof Error)||error.message!=='Session open was superseded by a newer selection.'||!current()||!deps.paneVisible('hermes-bots:pane')||!deps.isSelected(stored,route))throw error;
  await open(true);
 }
 check();return stored;
}

/** The host can restore the departing profile while the requested Bot tab mounts. */
export class ProfileTransition {
 cancelled=false;private sealed=false;private initial:string;private target:string;private connection:string;
 constructor(initial:string,target:string,connection='local'){this.initial=initial;this.target=target;this.connection=connection}
 observe(profile:string,scope?:Scope){
  // newChat briefly restores the default backend before the draft owner catches up.
  // Do not extend this exception to another owner, connection, or a settled session.
  const mountingDefault=!this.sealed&&profile==='default'&&scope!==undefined&&(scope.profile===this.target||scope.profile===this.initial)&&scope.connection===this.connection&&scope.session===null;
  if(profile!==this.target&&(this.sealed||profile!==this.initial)&&!mountingDefault)this.cancelled=true;
 }
 seal(){this.sealed=true}
}
