import type {Route,OpenSessionOptions} from '@hermes/plugin-sdk';
import type {Scope} from './hermes-bridge.ts';
/** Stored identity selects the Bot Chat; runtime identity authorizes the call. */
export function wakeBotReady(scope:Scope,target:string,connection:string,expectedStored:string,focusedStored:string|null){
 return scope.profile===target&&scope.connection===connection&&Boolean(scope.session)&&focusedStored===expectedStored;
}
interface Navigation {
 routes():Promise<Route[]>;
 activate(route:Route):Promise<void>;
 isSelected(stored:string,route:Route):boolean;
 request<T>(route:Route,method:string,params:Record<string,unknown>):Promise<T>;
 revealPane?(id:string):void;
 paneVisible?(id:string):boolean;
 label?(owner:string,name:string):void;
 openSession?(id:string,options:OpenSessionOptions):Promise<void>;
}
interface BotChat {id:string;resolved_id?:string;title?:string;root_title?:string;message_count?:number;live_message_count?:number}
/** Use the same exact-title registry as a Bots row click; never a remembered side thread. */
export async function openWakeBot(deps:Navigation,target:string,connection:string,name:string,current:()=>boolean):Promise<string>{
 const check=()=>{if(!current())throw new Error('HL_ERROR:errScope')};
 const routes=await deps.routes();check();
 const route=routes.find(r=>r.profile===target&&r.connectionId===connection&&r.mode!=='remote');
 if(!route)throw new Error('HL_ERROR:errScope');
 if(!deps.revealPane||!deps.paneVisible||!deps.openSession)throw new Error('HL_ERROR:errBotsView');
 deps.revealPane('hermes-bots:pane');check();
 if(!deps.paneVisible('hermes-bots:pane'))throw new Error('HL_ERROR:errBotsView');
 const result=await deps.request<{sessions:BotChat[]}>(route,'session.list',{profile:route.targetProfile||target,title:'Bot Chat',include_hidden:true,limit:200});check();
 if(!Array.isArray(result?.sessions)||result.sessions.length>1)throw new Error('HL_ERROR:errScope');
 const row=result.sessions[0];
 if(row&&(!row.id||(row.root_title||row.title)!=='Bot Chat'))throw new Error('HL_ERROR:errScope');
 let stored:string|undefined=row?.resolved_id||row?.id;
 if(!stored){
  // Hermes >=0.23 atomically resolves or creates this exact title, including concurrent opens.
  // A failed lookup never reaches this branch. No untitled/fresh-chat fallback is allowed.
  const created=await deps.request<{stored_session_id?:string}>(route,'session.create',{profile:route.targetProfile||target,title:'Bot Chat',hidden:true,follow_profile_config:true});check();
  stored=created.stored_session_id;
 }
 if(typeof stored!=='string'||!stored)throw new Error('HL_ERROR:errScope');
 await deps.activate(route);check();
 const owner=`bot:${route.connectionId}::${route.profile}`;
 deps.label?.(owner,name||target);
 const open=(refresh=false)=>deps.openSession!(stored!,{...(refresh?{refreshInPlace:true}:{}),profile:target,intent:'in-place',workspaceMode:'bots',workspaceOwnerKey:owner,
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
