import React,{useEffect,useState} from 'react';
import {Button,type PluginContext} from '@hermes/plugin-sdk';
import {Diagnostics,type DiagnosticReport} from './diagnostics.ts';
import {hint} from './ui.tsx';
export function DiagnosticsPanel({ctx,diagnostics,korean}:{ctx:PluginContext;diagnostics:Diagnostics;korean:boolean}){
 const [report,setReport]=useState<DiagnosticReport|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
 const c=(ko:string,en:string)=>korean?ko:en;
 const load=async()=>{try{const r=await ctx.rest<DiagnosticReport>('/diagnostics?include_text=true');diagnostics.consent(r);setReport(r);setError(false)}catch{setError(true)}};
 useEffect(()=>{void load();const id=setInterval(()=>void load(),3000);return()=>clearInterval(id)},[]);
 const detail=async(seconds:number)=>{setBusy(true);try{const r=await ctx.rest<DiagnosticReport>('/diagnostics/detail',{method:'POST',body:{seconds}});diagnostics.consent(r);setReport(r);setError(false)}catch{setError(true)}finally{setBusy(false)}};
 const toggle=async()=>{setBusy(true);try{await ctx.rest('/diagnostics/control',{method:'POST',body:{recording:report?.recording===false}});await load()}catch{setError(true)}finally{setBusy(false)}};
 const download=async()=>{setBusy(true);try{await diagnostics.flush();const r=await ctx.rest<DiagnosticReport>('/diagnostics');const blob=new Blob([JSON.stringify({...r,details:[],detailId:undefined},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`hermes-live-diagnostics-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setError(false)}catch{setError(true)}finally{setBusy(false)}};
 const time=(v:unknown)=>typeof v==='number'&&v>0?new Date(v*1000).toLocaleTimeString():'—';
 const labels:Record<string,string>={disabled:'호출 기능 꺼짐',no_match:'호출어 불일치',no_targets:'호출할 봇 없음',same_bot:'현재 봇 호출',matched:'일치',lease_timeout:'대기 연결 만료',lease_expired:'대기 연결 만료',foreign_owner:'다른 창이 마이크 사용',handoff_failed:'봇 전환 실패',start_failed:'통화 시작 실패',connected:'연결됨',cancelled:'취소됨',user_final_without_text:'완료 이벤트에 전사 없음',user_final:'사용자 발화 완료'};
 const reason=(v:unknown)=>korean?(labels[String(v)]??String(v??'')):String(v??'');
 const health=report?.last['runtime.health'];const active=Boolean(report&&report.detailUntil>Date.now()/1000);
 return <details style={{maxWidth:760,margin:'24px auto',padding:16,border:'1px solid var(--dt-border)',borderRadius:8}}>
  <summary style={{cursor:'pointer'}}>{c('개발자용 음성 인식 진단','Developer voice diagnostics')}</summary>
  <p style={hint}>{c('상태 로그는 이 기기에 최대 7일·2MB 보관합니다. 음성 녹음과 전사 원문은 파일에 저장하지 않습니다.','Status logs stay on this device for up to 7 days / 2 MB. Audio and transcripts are not written to log files.')}</p>
  <p>{c('프로필','Profile')}: {report?.profile??'—'} · {c('통화','Call')}: {String(health?.callState??'—')} · Wake: {String(health?.wakeState??'—')} · {c('마지막 상태','Last status')}: {time(health?.at)}</p>
  <p>{c('마지막 음성 입력','Last voice activity')}: {time(typeof health?.lastInputAt==='number'?health.lastInputAt/1000:undefined)} · {c('완료 전사','Completed transcript')}: {time(report?.last['transcript.final']?.at??report?.last['stt.result']?.at)}</p>
  {(error||report?.writeError||diagnostics.failed)&&<p role="alert">{c('진단 기록 또는 조회에 실패했습니다. 상태가 오래되었을 수 있습니다.','Diagnostics could not be saved or read. Displayed state may be stale.')}</p>}
  <p>{c('진단 기록','Diagnostic logging')}: {report?.recording===false?c('꺼짐 · 이전 기록 표시 중','Off · showing historical events'):c('켜짐','On')}</p>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
   <Button variant="secondary" disabled={busy||!report} onClick={()=>void toggle()}>{report?.recording===false?c('진단 기록 켜기','Turn logging on'):c('진단 기록 끄기','Turn logging off')}</Button>
   <Button disabled={busy||report?.recording===false} onClick={()=>void detail(active?0:300)}>{active?c('상세 진단 종료·전사 지우기','Stop detail capture and clear text'):c('5분간 전사 진단 켜기','Capture transcripts for 5 minutes')}</Button>
   <Button variant="secondary" disabled={busy} onClick={()=>void download()}>{c('상태 보고서 다운로드','Download status report')}</Button>
   <Button variant="ghost" onClick={()=>void load()}>{c('새로 확인','Refresh')}</Button>
  </div>
  <p style={hint}>{active?c(`전사 진단 중 · ${time(report?.detailUntil)}에 자동 종료됩니다.`,`Capturing transcripts until ${time(report?.detailUntil)}.`):c('상세 진단을 켜면 현재 프로필의 사용자 전사문을 최대 5분간 메모리에 표시합니다. 종료하거나 시간이 지나면 지워집니다. 봇을 바꾸면 해당 프로필에서 다시 켜세요.','Detail capture displays user transcripts in memory for up to 5 minutes in the current profile, then clears them. Enable it again after switching profiles.')}</p>
  {active&&<div style={{maxHeight:180,overflow:'auto'}}>{report?.details.slice(-15).map(e=><p key={e.id}>{time(e.at)} · {reason(e.reason??e.event)} · {String(e.text??'')}</p>)}</div>}
  <div style={{maxHeight:230,overflow:'auto',fontSize:12}} aria-label={c('최근 진단 기록','Recent diagnostic events')}>
   {report?.events.slice(-30).reverse().map(e=><div key={e.id}>{time(e.at)} · {e.event} · {reason(e.reason??e.state??e.callState??'')} {e.target?`→ ${e.target}`:''}</div>)}
  </div>
 </details>;
}
