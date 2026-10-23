import type {TokenUsage} from './usage.ts';
import type {ChatTurn} from './context.ts';
export type Provider = 'gemini' | 'grok' | 'codex' | 'qwen';
export interface Selection { provider: Provider; model: string; voice: string }
export interface Connection extends Selection { token: string; sampleRate: number; history?:ChatTurn[]; region?:'singapore'|'beijing' }
export interface CatalogItem { id: Provider; name: string; models: {id:string;name:string}[]; voices:string[]; sampleRate:number; available:boolean; reason:string|null; authState?:string }
export type LiveEvent = {type:'usage';tokens:TokenUsage} | {type:'audioUsage';audioMs:number} | {type:'ready'|'interrupt'|'turnEnd'} | {type:'audio';data:string;rate:number} | {type:'transcript';speaker:'user'|'assistant';text:string} | {type:'tool';id:string;name:string;request:string} | {type:'cancelTools';ids:string[]} | {type:'error';message:string};
export interface Transport { open():Promise<void>; audio(data:string):void; toolResult(id:string,result:string):void; close():void }
export interface AudioPort { open(rate:number,signal:AbortSignal,onFrame:(data:string,level:number)=>void):Promise<void>; play(data:string,rate:number):void; interrupt():void; mute(value:boolean):void; close():void }
