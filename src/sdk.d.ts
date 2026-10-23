declare module '@hermes/plugin-sdk' {
 import type {ComponentType,ReactNode} from 'react';
 export interface Atom<T>{get():T;subscribe(fn:(value:T)=>void):()=>void}
 export interface Route {connectionId:string;profile:string;targetProfile:string;mode?:string}
 export interface PluginContext {i18n:{register(bundles:Record<string,Record<string,string|((...args:unknown[])=>string)>>):()=>void;t(key:string,...args:unknown[]):string;onLocaleChange(fn:()=>void):()=>void};register(value:{id:string;area:string;order?:number;render:()=>ReactNode}):()=>void;onDispose(fn:()=>void):void;setInterval(fn:()=>void,ms:number):()=>void;rest<T>(path:string,opts?:{method?:string;body?:unknown;timeoutMs?:number}):Promise<T>;storage:{get<T>(key:string,fallback:T):T;set(key:string,value:unknown):void}}
 export const host:{navigate(path:string):void;state:{focusedSessionId:Atom<string|null>;focusedSessionOwner:Atom<{connectionId:string;profile:string}|null>;focusedSessionProfile:Atom<string>;connectionId:Atom<string|null>;profile:Atom<string>;busyBySession:Atom<Record<string,boolean>>;busy:Atom<boolean>};profileRoutes():Promise<Route[]>;requestProfile<T>(route:Route,method:string,params?:Record<string,unknown>):Promise<T>;composer:{submit(session:string|null,text:string):boolean};notify(value:{kind:string;message:string}):void};
 export function useI18n():{locale:string};
 export function usePluginI18n(id:string):(key:string,...args:unknown[])=>string;
 export const COMPOSER_AREAS:{actions:string};
 export const icons:{AudioLines:ComponentType<{className?:string}>;ChevronDown:ComponentType<{className?:string}>;iconSize:{sm:string;xs:string}};
 export const Select:ComponentType<any>,SelectContent:ComponentType<any>,SelectItem:ComponentType<any>,SelectTrigger:ComponentType<any>,SelectValue:ComponentType<any>,SegmentedControl:ComponentType<any>,DisclosureCaret:ComponentType<any>;
 export const Button:ComponentType<any>,Popover:ComponentType<any>,PopoverTrigger:ComponentType<any>,PopoverContent:ComponentType<any>,Tip:ComponentType<any>;
}
