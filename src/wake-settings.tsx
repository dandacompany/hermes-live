import React,{useEffect,useRef,useState} from 'react';
import {Button,type PluginContext} from '@hermes/plugin-sdk';
import {useLiveI18n} from './i18n-react.ts';
import {localizeError} from './i18n.ts';
import {host} from '@hermes/plugin-sdk';
import {setupCopy} from './setup-copy.ts';
import {settingsHref} from './auth.ts';
import {hint,divider} from './ui.tsx';
interface Bot {profile:string;display_name:string;enabled:boolean;ready:boolean;aliases:string[];auto_names?:string[];error:string}
const MAX_ALIASES=5;
const norm=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\s,，.!。！]/gu,'');
interface Registry {revision:string;bots:Bot[]}
export function WakeSettings({rest,changed,local}:{rest:PluginContext['rest'];changed:()=>void;local:boolean}){
 const {t,locale}=useLiveI18n();const c=setupCopy(locale);const [data,setData]=useState<Registry|null>(null),[aliases,setAliases]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const alive=useRef(true),request=useRef(0);
 const accept=(value:Registry)=>{setData(value);setAliases(Object.fromEntries(value.bots.map(b=>[b.profile,b.aliases.join(', ')])))};
 const load=async()=>{
  if(!local)return;const id=++request.current;setBusy(true);setError('');setSaved(false);
  try{const value=await rest<Registry>('/wake/bots');if(alive.current&&id===request.current)accept(value)}
  catch(e){if(alive.current&&id===request.current)setError(String(e))}
  finally{if(alive.current&&id===request.current)setBusy(false)}
 };
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++request.current}},[local]);
 const save=async()=>{
  if(!data||busy)return;const id=++request.current;setBusy(true);setError('');setSaved(false);
  try{
   const bots=data.bots.map(b=>{const own=new Set((b.auto_names??[]).map(norm));return {profile:b.profile,enabled:b.enabled,aliases:(aliases[b.profile]??'').split(/[,，]/u).map(n=>n.trim()).filter(n=>n&&!own.has(norm(n))&&(own.add(norm(n)),true))}});
   if(bots.some(b=>b.aliases.length>MAX_ALIASES))throw new Error('HL_ERROR:errWakeRegistry');
   const value=await rest<Registry>('/wake/bots',{method:'PUT',body:{revision:data.revision,bots}});
   if(alive.current&&id===request.current){accept(value);setSaved(true);changed()}
  }catch(e){if(alive.current&&id===request.current)setError(String(e))}
  finally{if(alive.current&&id===request.current)setBusy(false)}
 };
 if(!local)return <p style={hint}>{t('wakeLocalOnly')}</p>;
 return <section aria-label={t('wake')} style={{display:'grid',gap:12}}>
  <p style={{...hint,margin:0}}>{t('wakeDescription')}</p>
  {data?.bots.length===0&&<p>{c('noBots')}</p>}
  {data?.bots.map(bot=><div key={bot.profile} style={{display:'grid',gap:8,paddingBottom:12,borderBottom:divider}}>
   <label style={{display:'flex',gap:8,alignItems:'center'}}><input type="checkbox" checked={bot.enabled} disabled={busy||(!bot.ready&&!bot.enabled)} onChange={e=>{const enabled=e.target.checked;setSaved(false);setData({...data,bots:data.bots.map(b=>b.profile===bot.profile?{...b,enabled}:b)})}}/><strong>{bot.display_name||bot.profile}</strong></label>
   <label style={{display:'grid',gap:4,...hint}}>{t('wakeAliases')}<input aria-label={t('wakeAliasesFor',bot.display_name||bot.profile)} value={aliases[bot.profile]??''} disabled={busy||!bot.ready} maxLength={210} onChange={e=>{setSaved(false);setAliases({...aliases,[bot.profile]:e.target.value})}} placeholder={t('wakeAliasesHint')} style={{color:'var(--dt-foreground)',background:'var(--dt-background)',border:divider,borderRadius:4,padding:'6px 8px',fontSize:12}}/></label>
   {!!bot.auto_names?.length&&<div style={hint}>{t('wakeAutoNames',bot.auto_names.join(', '))}</div>}
   <div style={hint}>{bot.ready?t('wakeExample',bot.auto_names?.[0]||(aliases[bot.profile]??'').split(',')[0].trim()||'…'):t('wakeSetup')}</div>
   {!bot.ready&&<Button size="sm" variant="ghost" onClick={()=>host.navigate(settingsHref(bot.profile))}>{c('manage')}</Button>}
   {bot.error&&<div role="status" style={hint}>{t(bot.error==='duplicate'?'wakeDuplicate':bot.error==='name'?'wakeNameRequired':'wakeSetup')}</div>}
  </div>)}
  {error&&<div role="alert" style={hint}>{localizeError(t,error)}</div>}
  {saved&&<div role="status" style={hint}>{t('wakeSaved')}</div>}
  <div style={{display:'flex',gap:8}}><Button size="sm" disabled={busy||!data} onClick={()=>void save()}>{t('wakeSave')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void load()}>{busy?t('checking'):t('refresh')}</Button></div>
 </section>;
}
