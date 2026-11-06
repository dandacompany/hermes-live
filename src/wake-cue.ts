import url from './assets/wake.wav';
import {routeOutput} from './devices.ts';
/** Local acknowledgement only: playback failure must never cancel a call. */
export async function playWakeCue(output='',volume=1){
 if(volume<=0)return;
 let context:AudioContext|undefined;
 try{
  context=new AudioContext();const ac=context;
  const buffer=await (await fetch(url)).arrayBuffer();
  const [decoded]=await Promise.all([ac.decodeAudioData(buffer),ac.resume(),routeOutput(ac,output)]);
  const source=ac.createBufferSource();source.buffer=decoded;const gain=ac.createGain();gain.gain.value=Math.max(0,Math.min(1,volume));source.connect(gain);gain.connect(ac.destination);
  source.onended=()=>void ac.close().catch(()=>{});source.start();
 }catch{await context?.close().catch(()=>{})}
}
