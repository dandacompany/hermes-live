import {useLiveI18n} from './i18n-react.ts';
import {localizeError} from './i18n.ts';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@hermes/plugin-sdk';
import {FieldSelect,hint,section} from './ui.tsx';
import {AudioEngine} from './audio.ts';
import {audioDeviceError,type AudioDevices} from './devices.ts';
export function DeviceSettings({value,onChange,active}:{value:AudioDevices;onChange:(v:AudioDevices)=>void;active:boolean}){
 const {t}=useLiveI18n();
 const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[error,setError]=useState(''),[testing,setTesting]=useState(false),[level,setLevel]=useState(0);
 const test=useRef<AbortController|null>(null),alive=useRef(true);
 const refresh=async()=>{try{const list=await navigator.mediaDevices.enumerateDevices();if(alive.current)setDevices(list)}catch{if(alive.current)setError('HL_ERROR:errDevices')}};
 const stop=()=>{test.current?.abort();test.current=null;setTesting(false);setLevel(0)};
 useEffect(()=>{alive.current=true;void refresh();navigator.mediaDevices?.addEventListener('devicechange',refresh);return()=>{alive.current=false;test.current?.abort();test.current=null;navigator.mediaDevices?.removeEventListener('devicechange',refresh)}},[]);
 useEffect(()=>{if(active)stop()},[active]);
 const probe=async()=>{
  if(test.current){stop();return}
  const abort=new AbortController();test.current=abort;setTesting(true);setError('');
  const audio=new AudioEngine(()=>{},value);
  const timeout=setTimeout(()=>{if(test.current===abort)stop()},15000);
  abort.signal.addEventListener('abort',()=>{clearTimeout(timeout);audio.close()},{once:true});
  try{await audio.open(16000,abort.signal,(_data,rms)=>{if(alive.current&&!abort.signal.aborted)setLevel(rms)});if(!abort.signal.aborted)await refresh()}
  catch(e){if(alive.current&&!abort.signal.aborted)setError(audioDeviceError(e));if(test.current===abort)stop()}
 };
 const supported=typeof (AudioContext.prototype as any).setSinkId==='function';
 return <section aria-label={t('audio')} style={section}>
  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><span/><Button variant="ghost" size="sm" onClick={()=>void refresh()}>{t('refreshDevices')}</Button></div>
  {(['input','output'] as const).map(kind=>{
   const items=(kind==='output'&&!supported?[]:devices).filter(d=>d.kind===(kind==='input'?'audioinput':'audiooutput')&&d.deviceId&&d.deviceId!=='default');
   const options=[{value:'system',label:t('systemDefault')},...(value[kind]&&!items.some(d=>d.deviceId===value[kind])?[{value:'device:'+value[kind],label:t('missingDevice')}]:[]),...items.map((d,i)=>({value:'device:'+d.deviceId,label:d.label||`${kind==='input'?t('microphone'):t('speaker')} ${i+1}`}))];
   return <FieldSelect key={kind} label={kind==='input'?t('microphone'):t('speaker')} options={options} value={value[kind]?'device:'+value[kind]:'system'} disabled={active||testing} onChange={selected=>{setError('');onChange({...value,[kind]:selected==='system'?'':selected.slice(7)})}}/>;
  })}
  <div style={{display:'flex',alignItems:'center',gap:10}}><Button variant="secondary" size="sm" disabled={active} onClick={()=>void probe()}>{testing?t('stopTest'):t('microphoneTest')}</Button><div role="meter" aria-label={t('inputLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level*100)} style={{flex:1,height:6,borderRadius:4,overflow:'hidden',background:'var(--dt-muted)'}}><div style={{height:'100%',width:`${Math.round(level*100)}%`,background:'var(--dt-primary)',transition:'width 80ms linear'}}/></div></div>
  <div style={hint}>{testing?t('testHint'):t('deviceHint')}{!supported&&t('speakerHint')}</div>
  {error&&<div role="alert" style={hint}>{localizeError(t,error)}</div>}
 </section>;
}
