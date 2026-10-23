import React,{useEffect,useState} from 'react';
import {Button,SegmentedControl} from '@hermes/plugin-sdk';
import {hint,divider} from './ui.tsx';
import {PRICING_DATE,pricingLinks,summarize,type UsageData} from './usage.ts';
import {useLiveI18n} from './i18n-react.ts';
import {formatCalendarDate,formatDate,formatDuration,formatMoney,formatNumber,localizeError} from './i18n.ts';
import type {Provider,Selection} from './types.ts';
export interface Quota {plan:string;checkedAt:number;windows:{name:string;windowMinutes:number|null;usedPercent:number;resetsAt:number|null}[]}
const names={qwen:'Qwen Realtime',gemini:'Gemini Live',grok:'Grok Voice',codex:'Codex · GPT Live'};
export function UsageSettings({data,selection,readQuota}:{data:UsageData;selection:Selection;readQuota:()=>Promise<Quota>}){
 const {t,locale}=useLiveI18n();
 const duration=(ms:number)=>formatDuration(locale,ms),number=(n:number)=>formatNumber(locale,n),dollars=(n:number)=>formatMoney(locale,n);
 const [provider,setProvider]=useState<Provider>(selection.provider),[quota,setQuota]=useState<Quota|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let cancelled=false;if(provider!=='codex')return;setLoading(true);setError('');setQuota(null);void readQuota().then(value=>{if(!cancelled)setQuota(value)}).catch(()=>{if(!cancelled)setError('HL_ERROR:errQuota')}).finally(()=>{if(!cancelled)setLoading(false)});return()=>{cancelled=true}},[provider,refresh]);
 const total=summarize(data,provider),day=summarize(data,provider,Date.now()-86400000),five=summarize(data,provider,Date.now()-5*3600000);
 const tokenTotals=<><div>{t('tokens',number(total.input),number(total.output))}</div><div>{t('estimated',dollars(total.usd))}{total.unpriced>0?t('unpriced'):''}</div></>;
 const rates=(audioIn:number,audioOut:number,textIn:number,textOut:number)=><>{t('audioRates',dollars(audioIn),dollars(audioOut))}<br/>{t('textRates',dollars(textIn),dollars(textOut))}</>;
 return <section aria-label={t('usage')} style={{display:'grid',gap:12,fontSize:'.8125rem',overflowWrap:'anywhere'}}>
  <div role="group" aria-label={t('provider')}><SegmentedControl className="w-full" value={provider} onChange={(value:Provider)=>setProvider(value)} options={(['gemini','grok','codex','qwen'] as const).map(id=>({id,label:id==='codex'?'GPT':id==='gemini'?'Gemini':id==='qwen'?'Qwen':'Grok'}))}/></div>
  <strong>{names[provider]}</strong>
  <div style={{display:'flex',justifyContent:'space-between',gap:8}}><span>{t('last24')}</span><span>{duration(day.durationMs)} · {t('calls',number(day.calls))}</span></div>
  <div style={{display:'flex',justifyContent:'space-between',gap:8}}><span>{t('totalCalls')}</span><span>{duration(total.durationMs)} · {t('calls',number(total.calls))}</span></div>
  {provider==='gemini'&&<>{tokenTotals}<div style={hint}>{t('geminiHint')}</div><div style={hint}>{t('perMillion')}<br/>Gemini 3.8 / 3.1: {rates(3,12,.75,4.5)}<br/>Gemini 2.5: {rates(3,12,.5,2)}</div></>}
  {provider==='qwen'&&<>{tokenTotals}<div style={hint}>{t('qwenHint')}<br/>{t('perMillion')}<br/>Singapore: {rates(.93,1.87,.23,.7)}<br/>Beijing: {rates(.848,1.696,.212,.636)}</div></>}
  {provider==='grok'&&<><div>{t('estimated',dollars(total.usd))}</div><div style={hint}>{t('grokHint',dollars(.08),dollars(.004))}</div></>}
  {provider==='codex'&&<>
   <div>{t('last5')} {duration(five.durationMs)}</div>
   <div style={hint}>{t('reportedAudio',duration(total.audioMs))}</div>
   <div style={{borderTop:divider,paddingTop:10,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}><strong>{t('subscription',quota?.plan.toUpperCase()??'')}</strong><Button variant="ghost" size="sm" disabled={loading} onClick={()=>setRefresh(n=>n+1)}>{loading?t('refreshing'):t('refresh')}</Button></div>
   {error&&<div role="alert" style={hint}>{localizeError(t,error)}</div>}
   {quota?.windows.map((w,i)=><div key={i}><div style={{display:'flex',justifyContent:'space-between',gap:10}}><span>{w.windowMinutes===10080?t('weekly'):w.windowMinutes===300?t('fiveHours'):w.windowMinutes?t('minutes',number(w.windowMinutes)):t('limit')}</span><span>{t('remaining',number(w.usedPercent),number(100-w.usedPercent))}</span></div><progress aria-label={t('limit')} max={100} value={w.usedPercent} style={{width:'100%',height:6,accentColor:'var(--dt-primary)'}}/>{w.resetsAt&&<div style={hint}>{t('resets',formatDate(locale,w.resetsAt*1000))}</div>}</div>)}
   {quota&&<div style={hint}>{quota.windows.length?t('officialQuota'):t('noQuota')} {t('checked',formatDate(locale,quota.checkedAt*1000,true))}<br/>{t('quotaHint')}</div>}
  </>}
  <div style={{...hint,borderTop:divider,paddingTop:10}}>{t('localUsage',formatDate(locale,data.since))}</div>
  <a href={pricingLinks[provider]} target="_blank" rel="noreferrer" style={hint}>{provider==='codex'?t('quotaPage'):t('pricingPage')} ↗</a>{provider!=='codex'&&<div style={hint}>{t('pricingDate',formatCalendarDate(locale,PRICING_DATE))}</div>}
 </section>;
}
