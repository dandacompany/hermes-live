import type {Route} from '@hermes/plugin-sdk';
import type {Scope} from './hermes-bridge.ts';
/** Bots creates a real runtime session, unlike the ID-less main composer draft. */
export function wakeBotReady(scope:Scope,target:string,connection:string,previousSession:string|null){
 return scope.profile===target&&scope.connection===connection&&Boolean(scope.session)&&scope.session!==previousSession;
}
interface Navigation {
 routes():Promise<Route[]>;
 revealPane?(id:string):void;
 paneVisible?(id:string):boolean;
 label?(owner:string,name:string):void;
 newChat(route:Route,options:{workspaceMode:'bots';workspaceOwnerKey:string}):void;
}
/** Reveal Bots before publishing the exact new-chat owner: revealing restores the previous owner. */
export async function openWakeBot(deps:Navigation,target:string,connection:string,name:string,current:()=>boolean){
 const routes=await deps.routes();
 if(!current())throw new Error('HL_ERROR:errScope');
 const route=routes.find(r=>r.profile===target&&r.connectionId===connection&&r.mode!=='remote');
 if(!route)throw new Error('HL_ERROR:errScope');
 if(!deps.revealPane||!deps.paneVisible)throw new Error('HL_ERROR:errBotsView');
 deps.revealPane('hermes-bots:pane');
 if(!current())throw new Error('HL_ERROR:errScope');
 if(!deps.paneVisible('hermes-bots:pane'))throw new Error('HL_ERROR:errBotsView');
 const owner=`bot:${route.connectionId}::${route.profile}`;
 deps.label?.(owner,name||target);
 deps.newChat(route,{workspaceMode:'bots',workspaceOwnerKey:owner});
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
