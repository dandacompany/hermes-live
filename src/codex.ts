import {microphoneConstraints,routeOutput,type AudioDevices,defaultDevices} from './devices.ts';
import {historyNote,type ChatTurn} from './context.ts';
import type {AudioPort,Connection,LiveEvent,Transport} from './types.ts';
export type CodexRequest=<T>(path:string,body:unknown,timeoutMs?:number)=>Promise<T>;
export function decodeCodexEvent(message:any):LiveEvent[] {
 if(!message||typeof message!=='object')return [];
 if(message.type==='session.usage.updated'&&typeof message.usage?.audio_duration_ms==='number')return [{type:'audioUsage',audioMs:message.usage.audio_duration_ms}];
 if(message.type==='error')return [{type:'error',message:"HL_ERROR:errRejected"}];
 if(message.type==='session.closed')return [{type:'error',message:"HL_ERROR:errConnection"}];
 if(['input_transcript.added','output_transcript.added'].includes(message.type)&&typeof message.item?.text==='string')return [{type:'transcript',speaker:message.type==='input_transcript.added'?'user':'assistant',text:message.item.text}];
 if(message.type==='delegation.created'){
  const item=message.item;
  if(typeof item?.id!=='string'||item.target!=='client')return [];
  const text=(Array.isArray(item.content)?item.content:[]).filter((c:any)=>c.type==='input_text'&&typeof c.text==='string').map((c:any)=>c.text).join('\n');
  return [{type:'tool',id:item.id,name:'ask_hermes',request:text}];
 }
 if(message.type==='delegation.cancelled'&&typeof message.delegation_item_id==='string')return [{type:'cancelTools',ids:[message.delegation_item_id]}];
 if(message.type==='turn.done')return [{type:'turnEnd'}];
 return [];
}
// The subscription voice model does not infer Hermes capabilities from the
// client-managed handoff flag. Supply the actual backend role even for an empty
// chat, before the user speaks. This also works with already-loaded brokers.
const hermesCapabilities='Session setup only: do not speak or execute work in response to this setup. You are the voice frontend of Hermes Desktop, connected to the active Hermes chat. Backend tools: Hermes is a full agent on the connected computer; it can run commands, inspect disk space, read and edit files, browse and research using its configured tools and permissions. Use your native delegation mechanism to delegate requests to Hermes through the client. For example, if the user asks to check computer storage, delegate that exact request to Hermes, which can determine the operating system and run the appropriate read-only storage query. Do not claim that you cannot access the computer or ask the user to run commands themselves before trying this delegation. Delegate before acknowledging tool-dependent work, then wait for the actual result; never invent facts. Handle greetings and small talk yourself. This setup does not itself request any work. These rules apply to subsequent user speech.';
export function codexContext(history:readonly ChatTurn[]=[]){return {type:'session.context.append',content:[{type:'input_text',text:hermesCapabilities+historyNote(history)}]}}

export function codexToolResult(id:string,result:string){return {type:'delegation.context.append',delegation_item_id:id,content:[{type:'input_text',text:result}]}}

// WebRTC sends the original mic track and plays a remote media track. No PCM
// re-encoding, permanent credential, or subscription token reaches this class.
export class CodexMedia implements AudioPort {
 stream:MediaStream|null=null;
 private playback:HTMLAudioElement|null=null;
 private context:AudioContext|null=null;private sources:MediaStreamAudioSourceNode[]=[];private timer:ReturnType<typeof setInterval>|undefined;
 private closed=false;private muted=false;private speaking=false;private remote:AnalyserNode|null=null;
 private onSpeaking:(value:boolean)=>void;
 private devices:AudioDevices;
 constructor(onSpeaking:(value:boolean)=>void,devices:AudioDevices=defaultDevices){this.onSpeaking=onSpeaking;this.devices={...devices}}
 async open(_rate:number,signal:AbortSignal,onFrame:(data:string,level:number)=>void){
  if(this.closed||signal.aborted)throw new Error("HL_ERROR:errCancelled");
  signal.addEventListener('abort',()=>this.close(),{once:true});
  this.context=new AudioContext();await this.context.resume();
  if(this.closed||signal.aborted)throw new Error("HL_ERROR:errCancelled");
  await routeOutput(this.context!,this.devices.output);
  if(this.closed||signal.aborted)throw new Error("HL_ERROR:errCancelled");
  const stream=await navigator.mediaDevices.getUserMedia(microphoneConstraints(this.devices.input));
  if(this.closed||signal.aborted){stream.getTracks().forEach(t=>t.stop());throw new Error("HL_ERROR:errCancelled")}
  this.stream=stream;this.stream.getAudioTracks().forEach(track=>track.enabled=!this.muted);
  const source=this.context!.createMediaStreamSource(stream);this.sources.push(source);
  const analyser=this.context!.createAnalyser();analyser.fftSize=256;source.connect(analyser);
  const silence=this.context!.createGain();silence.gain.value=0;analyser.connect(silence);silence.connect(this.context!.destination);
  const level=(node:AnalyserNode)=>{const samples=new Float32Array(node.fftSize);node.getFloatTimeDomainData(samples);return Math.min(1,Math.sqrt(samples.reduce((s,n)=>s+n*n,0)/samples.length)*4)};
  this.timer=setInterval(()=>{
   if(this.closed)return;onFrame('',this.muted?0:level(analyser));
   const speaking=Boolean(this.remote&&level(this.remote)>.02);
   if(speaking!==this.speaking){this.speaking=speaking;this.onSpeaking(speaking)}
  },100);
 }
 receive(stream:MediaStream){
  if(this.closed||!this.context)return;
  // Chromium needs an active HTML media playout sink for remote WebRTC audio
  // to advance into Web Audio. Keep this sink muted; Web Audio owns audible output.
  this.playback?.pause();this.playback=new Audio();this.playback.srcObject=stream;
  this.playback.muted=true;this.playback.autoplay=true;void this.playback.play().catch(()=>{});
  const source=this.context.createMediaStreamSource(stream);this.sources.push(source);
  this.remote=this.context.createAnalyser();this.remote.fftSize=256;source.connect(this.remote);this.remote.connect(this.context.destination);
 }
 play(){} // Remote track is played by Web Audio; no queued PCM data.
 interrupt(){} // Codex/WebRTC handles native interruption on the remote track.
 mute(value:boolean){this.muted=value;this.stream?.getAudioTracks().forEach(t=>t.enabled=!value)}
 close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;this.sources.forEach(s=>s.disconnect());this.sources=[];this.remote?.disconnect();this.remote=null;if(this.playback){this.playback.pause();this.playback.srcObject=null;this.playback=null}void this.context?.close().catch(()=>{});this.context=null;this.onSpeaking(false)}
}

export class CodexRTC implements Transport {
 private pc:RTCPeerConnection|null=null;private channel:RTCDataChannel|null=null;private closed=false;private callId=crypto.randomUUID();
 private heartbeat:ReturnType<typeof setInterval>|undefined;private monitor:ReturnType<typeof setInterval>|undefined;
 private disconnectAt=0;private rejectReady:((reason:Error)=>void)|null=null;private readyTimer:ReturnType<typeof setTimeout>|undefined;
 private config:Connection;private media:CodexMedia;private request:CodexRequest;private emit:(event:LiveEvent)=>void;
 constructor(config:Connection,media:CodexMedia,request:CodexRequest,emit:(event:LiveEvent)=>void){this.config=config;this.media=media;this.request=request;this.emit=emit}
 async open(){
  if(this.closed||!this.media.stream)throw new Error("HL_ERROR:errAudio");
  const pc=new RTCPeerConnection({bundlePolicy:'max-bundle'});this.pc=pc;
  this.media.stream.getTracks().forEach(track=>pc.addTrack(track,this.media.stream!));
  const channel=pc.createDataChannel('oai-events');this.channel=channel;
  pc.ontrack=event=>{if(!this.closed)this.media.receive(event.streams[0]??new MediaStream([event.track]))};
  channel.onmessage=event=>{try{for(const item of decodeCodexEvent(JSON.parse(event.data)))this.emit(item)}catch{this.fail("HL_ERROR:errProtocol")}};
  channel.onclose=()=>{if(!this.closed)this.fail("HL_ERROR:errConnection")};
  // Install handlers before negotiation; a fast connection cannot beat them.
  let seeded=false;
  const ready=new Promise<void>((resolve,reject)=>{
   this.rejectReady=reject;this.readyTimer=setTimeout(()=>this.fail("HL_ERROR:errTimeout"),90000);
   const check=()=>{if(this.closed)return;if(pc.connectionState==='failed'){this.fail("HL_ERROR:errConnection");return}if(pc.connectionState==='connected'&&channel.readyState==='open'){if(!seeded){seeded=true;channel.send(JSON.stringify(codexContext(this.config.history)))}clearTimeout(this.readyTimer);this.rejectReady=null;resolve()}};
   channel.onopen=check;pc.onconnectionstatechange=check;
  });
  // Attach immediately so cancellation during HTTP negotiation cannot cause an unhandled rejection.
  void ready.catch(()=>{});
  try{
   await pc.setLocalDescription(await pc.createOffer());
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   const result=await this.request<{answer:string;callId:string;handoff:string}>('/codex/session',{callId:this.callId,model:this.config.model,voice:this.config.voice,offer:pc.localDescription!.sdp},90000);
   if(this.closed){void this.request('/codex/stop',{callId:this.callId}).catch(()=>{});throw new Error("HL_ERROR:errCancelled")}
   if(result.callId!==this.callId||result.handoff!=='client'||!result.answer)throw new Error("HL_ERROR:errProtocol");
   await pc.setRemoteDescription({type:'answer',sdp:result.answer});
   await ready;
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   this.heartbeat=setInterval(()=>{void this.request('/codex/heartbeat',{callId:this.callId},8000).catch(()=>{if(!this.closed)this.fail("HL_ERROR:errConnection")})},10000);
   this.monitor=setInterval(()=>{if(pc.connectionState==='disconnected'){if(!this.disconnectAt)this.disconnectAt=Date.now();if(Date.now()-this.disconnectAt>10000)this.fail("HL_ERROR:errConnection")}else this.disconnectAt=0},1000);
  }catch(error){this.close();throw error}
 }
 audio(){} // Original media tracks, not audio append events.
 toolResult(id:string,result:string){if(!this.closed&&this.channel?.readyState==='open')this.channel.send(JSON.stringify(codexToolResult(id,result)))}
 private fail(message:string){if(this.closed)return;this.emit({type:'error',message});this.close()}
 close(){if(this.closed)return;this.closed=true;clearInterval(this.heartbeat);clearInterval(this.monitor);clearTimeout(this.readyTimer);this.rejectReady?.(new Error("HL_ERROR:errCancelled"));this.rejectReady=null;if(this.channel){this.channel.onmessage=null;this.channel.onclose=null;this.channel.close()}if(this.pc){this.pc.ontrack=null;this.pc.onconnectionstatechange=null;this.pc.close()}void this.request('/codex/stop',{callId:this.callId},8000).catch(()=>{})}
}
