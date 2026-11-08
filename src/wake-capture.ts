/** PCM capture shares the already-authorized WebRTC microphone, never opens a device. */
export const wakeCaptureProcessor=`class WakeCapture extends AudioWorkletProcessor {
 constructor(){super();this.sum=0;this.count=0;this.phase=0;this.samples=[];this.seq=0}
 process(inputs){const c=inputs[0]?.[0];if(c){for(const n of c){this.sum+=n;this.count++;this.phase+=16000;
 if(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,this.sum/this.count));this.samples.push(Math.round(v*(v<0?32768:32767)));this.sum=0;this.count=0;
 if(this.samples.length===1280){const pcm=new Int16Array(this.samples);this.samples=[];this.port.postMessage({pcm,seq:++this.seq,at:currentTime},[pcm.buffer])}}}}return true}
}registerProcessor('hermes-live-wake-capture',WakeCapture);`;
export interface WakeUtterance {id:number;pcm:Int16Array;startedAt:number;endedAt:number}
/** Same bounded energy gate as local standby: never split long speech into a command tail. */
export class WakeUtteranceGate {
 private pre:Int16Array[]=[];private frames:Int16Array[]=[];private voiced=0;private quiet=0;private noise=45;private discarding=false;private serial=0;private startedAt=0;
 private start:(id:number)=>void;private end:(u:WakeUtterance)=>void;private drop:(reason:string)=>void;
 constructor(start:(id:number)=>void,end:(u:WakeUtterance)=>void,drop:(reason:string)=>void){this.start=start;this.end=end;this.drop=drop}
 reset(){this.pre=[];this.frames=[];this.voiced=this.quiet=0;this.discarding=false;this.noise=45}
 feed(frame:Int16Array,now:number){
  if(frame.length!==1280){this.reset();this.drop('capture_gap');return}
  let sum=0;for(const n of frame)sum+=n*n;const rms=Math.sqrt(sum/frame.length);const voice=rms>Math.max(160,this.noise*3);
  if(!voice)this.noise=.98*this.noise+.02*Math.min(rms,160);
  if(this.discarding){this.quiet=voice?0:this.quiet+1;if(this.quiet>=9)this.reset();return}
  if(!this.frames.length){this.pre.push(frame);this.pre=this.pre.slice(-3);if(voice){this.frames=this.pre.slice();this.voiced=1;this.startedAt=now-this.frames.length*80;this.start(++this.serial)}return}
  this.frames.push(frame);this.voiced+=Number(voice);this.quiet=voice?0:this.quiet+1;
  if(this.frames.length>=62){this.frames=[];this.pre=[];this.discarding=true;this.drop('long_speech');return}
  if(this.quiet>=9){
   if(this.voiced>=4){const pcm=new Int16Array(this.frames.length*1280);this.frames.forEach((f,i)=>pcm.set(f,i*1280));this.end({id:this.serial,pcm,startedAt:this.startedAt,endedAt:now})}
   else this.drop('too_short');
   this.reset();
  }
 }
}
