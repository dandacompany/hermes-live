import {microphoneConstraints,routeOutput,type AudioDevices,defaultDevices} from './devices.ts';
import { decodePCM, pcm16 } from './pcm.ts';
import type { AudioPort } from './types.ts';
// Capture in fixed 20 ms packets off the renderer thread. AudioContext performs
// device-rate conversion before the worklet receives its mono channel.
const processor=`class Capture extends AudioWorkletProcessor {
 constructor(){super();this.samples=[]}
 process(inputs){const channel=inputs[0]?.[0];if(channel){for(const n of channel)this.samples.push(n);const size=Math.round(sampleRate/50);while(this.samples.length>=size){const a=new Float32Array(this.samples.splice(0,size));this.port.postMessage(a,[a.buffer])}}return true}
}registerProcessor('hermes-live-capture',Capture);`;
export class AudioEngine implements AudioPort {
 private context:AudioContext|null=null;private stream:MediaStream|null=null;private worklet:AudioWorkletNode|null=null;private source:MediaStreamAudioSourceNode|null=null;
 private muted=false;private closed=false;private nextTime=0;private playing=new Set<AudioBufferSourceNode>();private onSpeaking:(v:boolean)=>void;
 private devices:AudioDevices;
 constructor(onSpeaking:(v:boolean)=>void=()=>{},devices:AudioDevices=defaultDevices){this.onSpeaking=onSpeaking;this.devices={...devices}}
 async open(rate:number,signal:AbortSignal,onFrame:(data:string,level:number)=>void){
  if(signal.aborted||this.closed)throw new Error("HL_ERROR:errCancelled");
  signal.addEventListener('abort',()=>this.close(),{once:true});
  this.context=new AudioContext({sampleRate:rate});await this.context.resume();
  if(signal.aborted||this.closed)throw new Error("HL_ERROR:errCancelled");
  await routeOutput(this.context!,this.devices.output);
  if(this.closed||signal.aborted)throw new Error("HL_ERROR:errCancelled");
  const stream=await navigator.mediaDevices.getUserMedia(microphoneConstraints(this.devices.input));
  if(signal.aborted||this.closed){stream.getTracks().forEach(t=>t.stop());throw new Error("HL_ERROR:errCancelled")}
  this.stream=stream;this.stream.getAudioTracks().forEach(track=>track.enabled=!this.muted);
  const url=URL.createObjectURL(new Blob([processor],{type:'application/javascript'}));
  try{await this.context!.audioWorklet.addModule(url)}finally{URL.revokeObjectURL(url)}
  if(signal.aborted||this.closed)throw new Error("HL_ERROR:errCancelled");
  this.worklet=new AudioWorkletNode(this.context!,'hermes-live-capture');
  this.worklet.port.onmessage=e=>{if(this.closed||this.muted)return;const samples=e.data as Float32Array;let sum=0;for(const n of samples)sum+=n*n;onFrame(pcm16(samples),Math.min(1,Math.sqrt(sum/samples.length)*4))};
  this.source=this.context!.createMediaStreamSource(stream);this.source.connect(this.worklet);
  const zero=this.context!.createGain();zero.gain.value=0;this.worklet.connect(zero);zero.connect(this.context!.destination);
 }
 play(data:string,rate:number){
  const ctx=this.context;if(!ctx||this.closed)return;
  if(this.nextTime-ctx.currentTime>15)throw new Error("HL_ERROR:errTimeout");
  const samples=decodePCM(data);if(!samples.length)return;
  const buffer=ctx.createBuffer(1,samples.length,rate);buffer.getChannelData(0).set(samples);
  const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);
  this.nextTime=Math.max(ctx.currentTime+.02,this.nextTime);source.start(this.nextTime);this.nextTime+=buffer.duration;this.playing.add(source);this.onSpeaking(true);
  source.onended=()=>{source.disconnect();this.playing.delete(source);if(!this.playing.size)this.onSpeaking(false)};
 }
 interrupt(){for(const s of this.playing){s.onended=null;try{s.stop()}catch{}s.disconnect()}this.playing.clear();this.nextTime=0;this.onSpeaking(false)}
 mute(value:boolean){this.muted=value;this.stream?.getAudioTracks().forEach(t=>t.enabled=!value)}
 close(){if(this.closed)return;this.closed=true;this.interrupt();this.worklet?.disconnect();if(this.worklet)this.worklet.port.onmessage=null;this.source?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;void this.context?.close().catch(()=>{});this.context=null}
}
