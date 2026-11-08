export interface SetupAssets {supported:boolean;engine:boolean;installed:boolean;prepared:boolean;model:string;bytes:number;source:string;error?:string;progress:{state?:string;received?:number;total?:number;error?:string}}
export interface SetupState {assets:SetupAssets;audio:{devices:string[];duplicates:string[];error:string};device:string;enabled:boolean;legacy:boolean;configured:boolean;greeting?:'Hey'|'헤이'}
export const preparingModel=(value?:SetupAssets)=>['downloading','verifying','preparing'].includes(value?.progress?.state??'');
export function basicReady(value:SetupState|null){return Boolean(value?.assets.supported&&value.assets.engine&&value.assets.installed&&value.device&&value.enabled&&!value.audio.error&&value.audio.devices.includes(value.device)&&!value.audio.duplicates.includes(value.device))}
export function setupSteps(mode:'wake'|'call'){return mode==='wake'?[0,1,2,3,4,5,6]:[0,2,4,6]}
