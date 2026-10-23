import type {Selection,Provider,Connection} from './types.ts';
export const PRICING_DATE='2026-10-23';
export const pricingLinks={qwen:'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime',gemini:'https://ai.google.dev/gemini-api/docs/pricing',grok:'https://docs.x.ai/developers/pricing',codex:'https://chatgpt.com/codex/settings/usage'};
export interface TokenUsage {input:number;output:number;inputAudio:number;inputText:number;outputAudio:number;outputText:number;complete:boolean}
const count=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:0;
export function qwenUsage(m:any):TokenUsage|null {
 if(!m||typeof m!=='object')return null;
 const input=count(m.input_tokens),output=count(m.output_tokens);
 const i=m.input_tokens_details??{},o=m.output_tokens_details??{};
 const cached=count(i.cached_tokens)>0;
 const inputAudio=cached?0:count(i.audio_tokens),inputText=cached?0:count(i.text_tokens);
 const outputAudio=count(o.audio_tokens),outputText=count(o.text_tokens);
 return {input,output,inputAudio,inputText,outputAudio,outputText,
  complete:!cached&&inputAudio+inputText===input&&outputAudio+outputText===output&&input+output>0};
}
export function qwenCost(model:string,u:TokenUsage,region?:Connection['region']):number|null {
 if(model!=='qwen3.8-omni-flash-realtime'||!region)return null;
 const r=region==='singapore'?[.93,1.87,.23,.70]:[.848,1.696,.212,.636];
 return (u.inputAudio*r[0]!+u.outputAudio*r[1]!+u.inputText*r[2]!+u.outputText*r[3]!)/1e6;
}
export function geminiUsage(m:any):TokenUsage|null {
 if(!m||typeof m!=='object')return null;
 const details=(rows:any)=>{const sums={AUDIO:0,TEXT:0};if(Array.isArray(rows))for(const r of rows)if(r?.modality==='AUDIO'||r?.modality==='TEXT')sums[r.modality as 'AUDIO'|'TEXT']+=count(r.tokenCount);return sums};
 const input=details(m.promptTokensDetails),output=details(m.responseTokensDetails);
 const i=count(m.promptTokenCount),o=count(m.responseTokenCount);
 return {input:i,output:o,inputAudio:count(m.cachedContentTokenCount)>0?0:input.AUDIO,inputText:count(m.cachedContentTokenCount)>0?0:input.TEXT,outputAudio:output.AUDIO,outputText:output.TEXT,complete:input.AUDIO+input.TEXT===i&&output.AUDIO+output.TEXT===o&&count(m.cachedContentTokenCount)===0&&count(m.toolUsePromptTokenCount)===0&&count(m.thoughtsTokenCount)===0&&(i+o>0)};
}
export function geminiCost(model:string,u:TokenUsage):number|null {
 const text=model==='gemini-2.5-flash-native-audio-latest'?[.5,2]:['gemini-3.8-live','gemini-3.1-flash-live-preview'].includes(model)?[.75,4.5]:null;
 if(!text)return null;
 return (u.inputText*text[0]!+u.inputAudio*3+u.outputText*text[1]!+u.outputAudio*12)/1e6;
}
export interface UsageRecord {id:string;provider:Provider;model:string;start:number;end:number;durationMs:number;audioMs:number;input:number;output:number;usd:number;unpriced:boolean;reports:number;priceDate:string;region?:Connection['region']}
export interface Totals {calls:number;durationMs:number;audioMs:number;input:number;output:number;usd:number;unpriced:number}
export const emptyTotals=():Totals=>({calls:0,durationMs:0,audioMs:0,input:0,output:0,usd:0,unpriced:0});
export interface UsageData {since:number;records:UsageRecord[];archived:Record<Provider,Totals>}
export const emptyUsage=():UsageData=>({since:Date.now(),records:[],archived:{gemini:emptyTotals(),grok:emptyTotals(),codex:emptyTotals(),qwen:emptyTotals()}});
function add(total:Totals,r:UsageRecord){total.calls++;for(const k of ['durationMs','audioMs','input','output','usd'] as const)total[k]+=r[k];total.unpriced+=Number(r.unpriced);return total}
export function summarize(data:UsageData,provider:Provider,since=0){
 const total=since?emptyTotals():{...emptyTotals(),...data.archived[provider]};
 for(const r of data.records)if(r.provider===provider&&r.end>since){
  if(since>r.start&&r.durationMs>0){const fraction=Math.max(0,Math.min(1,(r.end-since)/(r.end-r.start)));add(total,{...r,durationMs:r.durationMs*fraction,audioMs:r.audioMs*fraction})}
  else add(total,r);
 }
 return total;
}
// Only numeric usage is persisted. No audio, transcripts, credentials or device IDs.
export class UsageLedger {
 data:UsageData;private current:UsageRecord|null=null;
 constructor(data:UsageData,privateSave:(data:UsageData)=>void){this.data={...data,archived:{...emptyUsage().archived,...data.archived}};this.save=privateSave}
 private save:(data:UsageData)=>void;
 begin(selection:Selection & {region?:Connection['region']},now=Date.now()){
  this.current={id:crypto.randomUUID(),provider:selection.provider,model:selection.model,start:now,end:now,durationMs:0,audioMs:0,input:0,output:0,usd:0,unpriced:['gemini','qwen'].includes(selection.provider),reports:0,priceDate:PRICING_DATE,region:selection.region};this.flush(now);
 }
 tokens(u:TokenUsage){const r=this.current;if(!r||!['gemini','qwen'].includes(r.provider))return;r.input+=u.input;r.output+=u.output;const cost=r.provider==='qwen'?qwenCost(r.model,u,r.region):geminiCost(r.model,u);r.unpriced=(r.reports>0&&r.unpriced)||cost===null||!u.complete;r.usd+=cost??0;r.reports++;this.flush()}
 audio(ms:number){if(this.current&&Number.isFinite(ms)&&ms>=0){this.current.audioMs=Math.max(this.current.audioMs,ms);this.flush()}}
 flush(now=Date.now()){
  const r=this.current;if(!r)return;r.end=Math.max(r.end,now);r.durationMs=r.end-r.start;
  // Grok's published minute rate, using connected time as an explicit estimate.
  // Text input charges are excluded and disclosed in the UI.
  if(r.provider==='grok')r.usd=r.durationMs/60000*.08;
  const records=this.data.records.filter(x=>x.id!==r.id);records.push({...r});
  while(records.length>2000||(records[0]&&records[0].end<now-31*86400000)){const old=records.shift()!;add(this.data.archived[old.provider],old)}
  this.data={...this.data,records};this.save(this.data);
 }
 end(now=Date.now()){this.flush(now);this.current=null}
}
