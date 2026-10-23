import React,{useEffect,useState} from 'react';
import {Button,DisclosureCaret} from '@hermes/plugin-sdk';
import {useLiveI18n} from './i18n-react.ts';
import {hint,divider,section} from './ui.tsx';
import type {CatalogItem,Provider} from './types.ts';
export function AuthSettings({provider,selected,backend,connection,profile,active,loading,configure,recheck}:{provider?:CatalogItem;selected:Provider;backend:string;connection:string;profile:string;active:boolean;loading:boolean;configure:()=>void;recheck:()=>void}){
 const {t}=useLiveI18n();const codex=selected==='codex';const [expanded,setExpanded]=useState(false);
 useEffect(()=>{setExpanded(provider?.available===false)},[selected,provider?.available]);
 return <section aria-label={t('authentication')} style={{...section,borderTop:divider,paddingTop:16}}>
  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
   <strong style={{fontSize:'.8125rem'}}>{t('authentication')}</strong>
   <Button variant="ghost" size="sm" disabled={active||loading} onClick={recheck}>{loading?t('checking'):t('refresh')}</Button>
  </div>
  <div style={{...section,gap:4}}>
   {provider?.available&&<p role="status" style={{...hint,color:'var(--dt-foreground)'}}>{t(codex?'authSignedIn':'authConfigured')}</p>}
   <p style={{...hint,overflowWrap:'anywhere'}}>{t('authTarget',backend||'—',connection,profile)}</p>
  </div>
  {codex?<div style={{display:'grid',gap:expanded?12:0}}>
   <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} style={{justifyContent:'flex-start',gap:6,paddingInline:0,width:'fit-content'}}><DisclosureCaret open={expanded}/>{t('authSignIn')}</Button>
   {expanded&&<div style={{...section,...hint,gap:12}}>
    <p style={{margin:0}}>{t('authCodexScope')}</p>
    {[['authLocal','codex login'],['authRemote','codex login --device-auth']].map(([key,command])=><div key={key} style={{display:'grid',gap:6}}>
     <p style={{margin:0}}>{t(key as 'authLocal'|'authRemote')}</p>
     <code style={{display:'block',userSelect:'text',padding:'8px 10px',border:divider,borderRadius:'var(--radius-sm)',background:'var(--ui-bg-tertiary)',color:'var(--dt-foreground)',overflowWrap:'anywhere'}}>{command}</code>
    </div>)}
    <a href="https://developers.openai.com/codex/auth/" target="_blank" rel="noreferrer" style={{color:'var(--dt-primary)',textDecoration:'underline',textUnderlineOffset:3}}>{t('authDocs')}</a>
   </div>}
  </div>:<Button variant="secondary" size="sm" disabled={active||loading} onClick={configure} style={{justifySelf:'start'}}>{t('authConfigure')}</Button>}
 </section>;
}
