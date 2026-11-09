import React,{useEffect,useRef,useState} from 'react';
import {Button,type PluginContext} from '@hermes/plugin-sdk';
import {useLiveI18n} from './i18n-react.ts';
import {localizeError} from './i18n.ts';
import {setupCopy,setupError} from './setup-copy.ts';
import {hint,divider} from './ui.tsx';
interface GenericWake {enabled:boolean;phrase:string;supported:boolean;default:string;max:number;conflict:boolean}
/** Optional generic wake phrase (off by default): it calls the agent of the focused chat, not a bot. */
export function GenericWakeSettings({rest,changed,local}:{rest:PluginContext['rest'];changed:()=>void;local:boolean}){
 const {t,locale}=useLiveI18n();const c=setupCopy(locale);
 const [data,setData]=useState<GenericWake|null>(null),[phrase,setPhrase]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const alive=useRef(true),request=useRef(0);
 const accept=(value:GenericWake)=>{setData(value);setPhrase(value.phrase)};
 const load=async()=>{
  if(!local)return;const id=++request.current;setBusy(true);setError('');setSaved(false);
  try{const value=await rest<GenericWake>('/setup/generic');if(alive.current&&id===request.current)accept(value)}
  catch(e){if(alive.current&&id===request.current)setError(String(e))}
  finally{if(alive.current&&id===request.current)setBusy(false)}
 };
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++request.current}},[local]);
 const save=async(enabled:boolean,value:string)=>{
  if(!data||busy)return;const id=++request.current;setBusy(true);setError('');setSaved(false);
  try{
   const next=await rest<GenericWake>('/setup/generic',{method:'PUT',body:{enabled,phrase:value.trim()||data.phrase}});
   if(alive.current&&id===request.current){accept(next);setSaved(true);changed()}
  }catch(e){if(alive.current&&id===request.current)setError(String(e))}
  finally{if(alive.current&&id===request.current)setBusy(false)}
 };
 if(!local)return null;
 const off=busy||!data||!data.supported;
 return <section aria-label={c('genericTitle')} style={{display:'grid',gap:8,paddingTop:12,borderTop:divider}}>
  <label style={{display:'flex',gap:8,alignItems:'center'}}><input type="checkbox" checked={data?.enabled??false} disabled={busy||!data||(!data.supported&&!data.enabled)} onChange={e=>void save(e.target.checked,phrase)}/><strong>{c('genericTitle')}</strong></label>
  <p style={hint}>{c(data&&!data.supported?'genericUnsupported':'genericHint')}</p>
  <label style={{display:'grid',gap:4,...hint}}>{c('genericPhrase')}<input aria-label={c('genericPhrase')} value={phrase} disabled={off} maxLength={data?.max??40} onChange={e=>{setSaved(false);setPhrase(e.target.value)}} placeholder={data?.default??'Wake up'} style={{color:'var(--dt-foreground)',background:'var(--dt-background)',border:divider,borderRadius:4,padding:'6px 8px',fontSize:12}}/></label>
  {data?.conflict&&<div role="status" style={hint}>{c('genericConflict')}</div>}
  {error&&<div role="alert" style={hint}>{setupError(locale,error)||localizeError(t,error)}</div>}
  {saved&&<div role="status" style={hint}>{c('genericSaved')}</div>}
  <div style={{display:'flex',gap:8}}><Button size="sm" disabled={off||!phrase.trim()||phrase.trim()===data?.phrase} onClick={()=>void save(data!.enabled,phrase)}>{c('genericSave')}</Button></div>
 </section>;
}
