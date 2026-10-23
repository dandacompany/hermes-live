import {CodexMedia as RealtimeMedia,type CodexRequest} from './codex.ts';
import {instructions,tool,decodeProviderEvent} from './providers.ts';
import {historyNote} from './context.ts';
import {GrokToolTurns as ToolTurns} from './grok-tools.ts';
import {qwenUsage} from './usage.ts';
import type {Connection,LiveEvent,Transport} from './types.ts';

export function qwenSetup(config:Connection){
 return {type:'session.update',session:{modalities:['text','audio'],
  instructions:instructions+historyNote(config.history),
  audio:{output:{voice:config.voice}},
  input_audio_transcription:{model:'qwen3-asr-flash-realtime'},
  turn_detection:{type:'semantic_vad'},
  tools:[{type:'function',function:tool}]}};
}
export function decodeQwenEvent(message:any):LiveEvent[]{
 if(message?.type==='response.done'&&message.response?.status==='failed')return [{type:'error',message:"HL_ERROR:errRejected"}];
 // WebRTC carries audio through RTP, never play duplicate PCM from a data event.
 const events=decodeProviderEvent('qwen',message).filter(e=>e.type!=='audio');
 if(message?.type==='response.done'){
  const usage=qwenUsage(message.response?.usage);if(usage)events.push({type:'usage',tokens:usage});
 }
 return events;
}

/** Qwen uses a server-created `txt` data channel, unlike Codex's client channel.
 * Keep mic media gated until session.updated confirms context/tools/voice.
 * Docs: alibabacloud.com/help/en/model-studio/realtime
 */
export class QwenRTC implements Transport {
 private pc:RTCPeerConnection|null=null;private channel:RTCDataChannel|null=null;
 private channels=new Set<RTCDataChannel>();private seen=new Set<string>();private turns=new ToolTurns();
 private closed=false;private configured=false;private seeded=false;private ready=false;
 private rejectReady:((error:Error)=>void)|null=null;private rejectIce:((error:Error)=>void)|null=null;
 private timer:ReturnType<typeof setTimeout>|undefined;private monitor:ReturnType<typeof setInterval>|undefined;
 private iceTimer:ReturnType<typeof setTimeout>|undefined;private disconnectAt=0;
 private config:Connection;private media:RealtimeMedia;private request:CodexRequest;private emit:(e:LiveEvent)=>void;
 constructor(config:Connection,media:RealtimeMedia,request:CodexRequest,emit:(e:LiveEvent)=>void){this.config=config;this.media=media;this.request=request;this.emit=emit}
 async open(){
  if(this.closed||!this.media.stream)throw new Error("HL_ERROR:errAudio");
  const pc=new RTCPeerConnection({bundlePolicy:'max-bundle'});this.pc=pc;
  const senders=this.media.stream.getAudioTracks().map(track=>({track,sender:pc.addTrack(track,this.media.stream!)}));
  let resolveReady!:()=>void;
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;this.rejectReady=reject});void ready.catch(()=>{});
  this.timer=setTimeout(()=>this.fail("HL_ERROR:errTimeout"),60000);
  const check=()=>{
   if(this.closed)return;
   if(pc.connectionState==='failed'){this.fail("HL_ERROR:errConnection");return}
   if(this.ready||!this.configured||pc.connectionState!=='connected')return;
   this.ready=true;
   void Promise.all(senders.map(({sender,track})=>sender.replaceTrack(track))).then(()=>{
    if(this.closed)return;clearTimeout(this.timer);this.rejectReady=null;resolveReady();
   }).catch(()=>this.fail("HL_ERROR:errAudio"));
  };
  const bind=(channel:RTCDataChannel)=>{
   this.channels.add(channel);
   channel.onclose=()=>{if(channel===this.channel&&!this.closed)this.fail("HL_ERROR:errConnection")};
   channel.onerror=()=>this.fail("HL_ERROR:errProtocol");
   channel.onmessage=event=>{
    if(this.closed)return;
    try{
     const message=JSON.parse(event.data);
     if(typeof message.event_id==='string'){
      if(this.seen.has(message.event_id))return;
      this.seen.add(message.event_id);if(this.seen.size>2048)this.seen.delete(this.seen.values().next().value!);
     }
     if(!this.seeded&&(message.type==='session.created'||channel.label==='txt')){
      this.seeded=true;this.channel=channel;this.send(qwenSetup(this.config));
      if(message.type==='session.updated')return; // An initial event is not an acknowledgment of our update.
     }
     this.turns.observe(message);
     for(const item of decodeQwenEvent(message)){
      if(this.closed)return;
      if(item.type==='ready'){this.configured=true;check();continue}
      if(item.type==='error'){this.fail(item.message);return}
      this.emit(item);
     }
     this.resume();
    }catch{this.fail("HL_ERROR:errProtocol")}
   };
  };
  bind(pc.createDataChannel('oai-events'));
  pc.ondatachannel=event=>bind(event.channel);
  pc.ontrack=event=>{if(!this.closed)this.media.receive(event.streams[0]??new MediaStream([event.track]))};
  pc.onconnectionstatechange=check;
  try{
   await Promise.all(senders.map(({sender})=>sender.replaceTrack(null)));
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   await pc.setLocalDescription(await pc.createOffer());
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   // Signaling is a single SDP exchange, not trickle ICE; include local candidates.
   if(pc.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{
    this.rejectIce=reject;
    this.iceTimer=setTimeout(()=>reject(new Error("HL_ERROR:errConnection")),10000);
    pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(this.iceTimer);this.rejectIce=null;resolve()}};
   });
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   const result=await this.request<{answer:string;region:Connection['region']}>('/qwen/session',{model:this.config.model,voice:this.config.voice,offer:pc.localDescription!.sdp},40000);
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   if(!result.answer?.startsWith('v=0')||!['singapore','beijing'].includes(result.region??''))throw new Error("HL_ERROR:errProtocol");
   this.config.region=result.region;
   await pc.setRemoteDescription({type:'answer',sdp:result.answer});await ready;
   if(this.closed)throw new Error("HL_ERROR:errCancelled");
   this.monitor=setInterval(()=>{if(pc.connectionState==='disconnected'){if(!this.disconnectAt)this.disconnectAt=Date.now();if(Date.now()-this.disconnectAt>10000)this.fail("HL_ERROR:errConnection")}else this.disconnectAt=0},1000);
  }catch(error){this.close();throw error}
 }
 audio(){} // Microphone is an RTP track.
 private send(value:unknown){
  if(this.closed)return;
  if(this.channel?.readyState!=='open'){this.fail("HL_ERROR:errConnection");return}
  if(this.channel.bufferedAmount>1024*1024){this.fail("HL_ERROR:errTimeout");return}
  this.channel.send(JSON.stringify(value));
 }
 toolResult(id:string,result:string){this.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:id,output:result}});this.turns.output(id);this.resume()}
 private resume(){for(let n=this.turns.takeReady();n>0;n--)this.send({type:'response.create'})}
 private fail(message:string){if(this.closed)return;this.emit({type:'error',message});this.close()}
 close(){
  if(this.closed)return;this.closed=true;clearTimeout(this.timer);clearTimeout(this.iceTimer);clearInterval(this.monitor);
  const error=new Error("HL_ERROR:errCancelled");this.rejectReady?.(error);this.rejectReady=null;this.rejectIce?.(error);this.rejectIce=null;
  for(const channel of this.channels){channel.onmessage=null;channel.onclose=null;channel.onerror=null;channel.close()}this.channels.clear();this.channel=null;
  if(this.pc){this.pc.ondatachannel=null;this.pc.ontrack=null;this.pc.onconnectionstatechange=null;this.pc.onicegatheringstatechange=null;this.pc.close();this.pc=null}
 }
}
