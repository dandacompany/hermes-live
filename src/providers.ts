import {geminiUsage} from './usage.ts';
import {historyNote} from './context.ts';
import {GrokToolTurns} from './grok-tools.ts';
import type { Connection, LiveEvent, Provider, Transport } from './types.ts';
export const instructions='You are Hermes Live, a calm voice companion. Speak in the language the user uses. For requests requiring actions, files, tools, research, current facts, or careful reasoning, call ask_hermes with a complete request including relevant spoken context. Hermes owns its tools and approvals. Do not invent results; wait for its response. Brief social conversation can be answered directly. When interrupted, listen. Do not read Markdown formatting aloud.';
export const tool={name:'ask_hermes',description:'Ask the current Hermes chat to do work or answer a factual question. Include all details from this conversation.',parameters:{type:'object',properties:{request:{type:'string',description:'Complete request for Hermes'}},required:['request']}};
export function connectionURL(c:Connection):string {
 return c.provider==='gemini'
 ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(c.token)}`
 : `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(c.model)}`;
}
export function setupMessage(c:Connection): any {
 return c.provider==='gemini'?{setup:{model:`models/${c.model}`,generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:c.voice}}}},systemInstruction:{parts:[{text:instructions+historyNote(c.history)}]},inputAudioTranscription:{},outputAudioTranscription:{},tools:[{functionDeclarations:[{...tool,behavior:'BLOCKING'}]}]}}
 :{type:'session.update',session:{voice:c.voice,instructions:instructions+historyNote(c.history),turn_detection:{type:'server_vad'},audio:{input:{format:{type:'audio/pcm',rate:24000}},output:{format:{type:'audio/pcm',rate:24000}}},tools:[{type:'function',...tool}]}};
}
export function decodeProviderEvent(provider:Provider,m:any):LiveEvent[] {
 if(!m||typeof m!=='object')return [];
 const out:LiveEvent[]=[];
 if(m.error)return [{type:'error',message:"HL_ERROR:errRejected"}];
 if(provider==='gemini'){
  const usage=geminiUsage(m.usageMetadata);if(usage)out.push({type:'usage',tokens:usage});
  if(m.setupComplete)out.push({type:'ready'});
  const s=m.serverContent;
  if(s?.interrupted)out.push({type:'interrupt'});
  for(const p of s?.modelTurn?.parts??[]){if(typeof p.inlineData?.data==='string')out.push({type:'audio',data:p.inlineData.data,rate:24000})}
  for(const [key,speaker] of [['inputTranscription','user'],['outputTranscription','assistant']] as const){if(typeof s?.[key]?.text==='string')out.push({type:'transcript',speaker,text:s[key].text})}
  if(s?.turnComplete)out.push({type:'turnEnd'});
  for(const f of m.toolCall?.functionCalls??[]){if(typeof f.id==='string')out.push({type:'tool',id:f.id,name:f.name,request:typeof f.args?.request==='string'?f.args.request:''})}
  if(m.toolCallCancellation?.ids)out.push({type:'cancelTools',ids:m.toolCallCancellation.ids});
  if(m.goAway)out.push({type:'error',message:"HL_ERROR:errTimeout"});
 }else{
  if(m.type==='session.updated')out.push({type:'ready'});
  if(['response.audio.delta','response.output_audio.delta'].includes(m.type)&&typeof m.delta==='string')out.push({type:'audio',data:m.delta,rate:24000});
  if(['response.audio_transcript.delta','response.output_audio_transcript.delta'].includes(m.type)&&typeof m.delta==='string')out.push({type:'transcript',speaker:'assistant',text:m.delta});
  if(m.type==='conversation.item.input_audio_transcription.completed'&&typeof m.transcript==='string')out.push({type:'transcript',speaker:'user',text:m.transcript});
  if(m.type==='input_audio_buffer.speech_started')out.push({type:'interrupt'});
  if(m.type==='response.done')out.push({type:'turnEnd'});
  if(m.type==='response.function_call_arguments.done'){
   try{const args=JSON.parse(m.arguments);out.push({type:'tool',id:m.call_id,name:m.name,request:typeof args.request==='string'?args.request:''})}
   catch{out.push({type:'error',message:"HL_ERROR:errProtocol"})}
  }
 }
 return out;
}
export class LiveSocket implements Transport {
 private grokTools=new GrokToolTurns();
 private socket:WebSocket|null=null;private closed=false;private ready=false;private rejectOpen:((error:Error)=>void)|null=null;
 private config:Connection;private emit:(event:LiveEvent)=>void;private timer:ReturnType<typeof setTimeout>|undefined;
 constructor(config:Connection,emit:(event:LiveEvent)=>void){this.config=config;this.emit=emit}
 open():Promise<void>{return new Promise((resolve,reject)=>{
  this.rejectOpen=reject;
  const ws=new WebSocket(connectionURL(this.config),this.config.provider==='grok'?[`xai-client-secret.${this.config.token}`]:undefined);this.socket=ws;
  this.timer=setTimeout(()=>this.fail("HL_ERROR:errTimeout"),20000);
  ws.onopen=()=>this.send(setupMessage(this.config));
  let chain=Promise.resolve();
  ws.onmessage=e=>{chain=chain.then(async()=>{
   if(this.closed)return;
   const raw=typeof e.data==='string'?e.data:await e.data.text();
   const message=JSON.parse(raw);
   if(this.config.provider==='grok')this.grokTools.observe(message);
   const events=decodeProviderEvent(this.config.provider,message);
   for(const event of events){
    if(this.closed)return;
    if(event.type==='ready'){this.ready=true;clearTimeout(this.timer);this.rejectOpen=null;resolve()}
    if(event.type==='error'){this.fail(event.message);return}
    this.emit(event);
   }
   this.resumeGrok();
  }).catch(()=>this.fail("HL_ERROR:errProtocol"))};
  ws.onerror=()=>this.fail("HL_ERROR:errConnection");
  ws.onclose=()=>{if(!this.closed)this.fail("HL_ERROR:errConnection")};
 })}
 private fail(message:string){if(this.closed)return;this.rejectOpen?.(new Error(message));this.rejectOpen=null;this.emit({type:'error',message});this.close()}
 private send(value:unknown){if(this.closed||this.socket?.readyState!==WebSocket.OPEN)return;if(this.socket.bufferedAmount>1024*1024){this.fail("HL_ERROR:errTimeout");return}this.socket.send(JSON.stringify(value))}
 audio(data:string){if(!this.ready)return;this.send(this.config.provider==='gemini'?{realtimeInput:{audio:{data,mimeType:'audio/pcm;rate=16000'}}}:{type:'input_audio_buffer.append',audio:data})}
 toolResult(id:string,result:string){
  if(this.config.provider==='gemini')this.send({toolResponse:{functionResponses:[{id,name:'ask_hermes',response:{result}}]}});
  else{this.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:id,output:result}});this.grokTools.output(id);this.resumeGrok()}
 }
 private resumeGrok(){for(let n=this.grokTools.takeReady();n>0;n--)this.send({type:'response.create'})}
 close(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.rejectOpen?.(new Error("HL_ERROR:errCancelled"));this.rejectOpen=null;if(this.socket){this.socket.onclose=null;this.socket.onerror=null;this.socket.onmessage=null;this.socket.onopen=null;this.socket.close();this.socket=null}}
}
