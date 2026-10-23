import {en,type MessageKey} from './locales/en.ts';
import translations from './locales/translations.json' with {type:'json'};
import legacyErrors from './locales/legacy-errors.json' with {type:'json'};

export type Translate=(key:MessageKey,...args:unknown[])=>string;
export const catalogs:Record<string,Record<MessageKey,string>>={en,...translations};
export const supportedLocales=Object.keys(catalogs);
export function formatMessage(template:string,args:unknown[]){return template.replace(/\{(\d+)\}/g,(_,index)=>String(args[Number(index)]??''))}
// The SDK's plugin catalog accepts strings or functions, not string templates.
export const bundles=Object.fromEntries(Object.entries(catalogs).map(([locale,messages])=>[locale,Object.fromEntries(Object.entries(messages).map(([key,value])=>[key,(...args:unknown[])=>formatMessage(value,args)]))]));
export function translate(locale:string,key:MessageKey,...args:unknown[]){return formatMessage(catalogs[locale]?.[key]??en[key],args)}

// Retain codes in call state so an existing error changes language immediately.
// Legacy backend messages remain supported during a rolling plugin update.
const legacyEntries=Object.entries(legacyErrors).sort((a,b)=>b[0].length-a[0].length);
export function errorKey(value:unknown):MessageKey{
 const text=value instanceof Error?value.message:String(value??'');
 const code=text.match(/HL_ERROR:(err[A-Za-z]+)/)?.[1];
 if(code&&Object.hasOwn(en,code))return code as MessageKey;
 for(const [message,key] of legacyEntries)if(text.includes(message))return key as MessageKey;
 return 'errGeneric';
}
export function localizeError(t:Translate,value:unknown){return value?t(errorKey(value)):''}
export function intlLocale(locale:string){try{return Intl.getCanonicalLocales(locale)[0]||'en'}catch{return 'en'}}
export function formatNumber(locale:string,value:number){return new Intl.NumberFormat(intlLocale(locale)).format(value)}
export function formatMoney(locale:string,value:number){return new Intl.NumberFormat(intlLocale(locale),{style:'currency',currency:'USD',minimumFractionDigits:4,maximumFractionDigits:4}).format(value)}
export function formatDuration(locale:string,ms:number){
 const seconds=Math.floor(ms/1000),l=intlLocale(locale);
 const unit=(n:number,u:string)=>new Intl.NumberFormat(l,{style:'unit',unit:u,unitDisplay:'short'}).format(n);
 return seconds<60?unit(seconds,'second'):`${unit(Math.floor(seconds/60),'minute')} ${unit(seconds%60,'second')}`;
}
export function formatDate(locale:string,value:number,timeOnly=false){return new Intl.DateTimeFormat(intlLocale(locale),timeOnly?{timeStyle:'medium'}:{dateStyle:'medium',timeStyle:'short'}).format(value)}

export function formatCalendarDate(locale:string,date:string){return new Intl.DateTimeFormat(intlLocale(locale),{dateStyle:'medium',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'))}
