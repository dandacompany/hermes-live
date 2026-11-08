/** Local-only, persistent model worker. This worker never persists PCM or transcripts. */
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {matchWakeTarget} from './wake-phrase.mjs';
const cfg=JSON.parse(process.argv[2]);
const targets=cfg.targets;const vocabulary=[...new Set(targets.flatMap(t=>t.names))];
const {LocalWhisper}=await import(pathToFileURL(cfg.module).href);
const local=new LocalWhisper(cfg.models,cfg.engine),cancel=new AbortController();
const options={kind:'local',localModel:cfg.model,language:'ko',timeoutMs:15000};
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let closing=false;
async function close(){if(closing)return;closing=true;cancel.abort();await local.close();}
process.on('SIGTERM',()=>void close().finally(()=>process.exit(0)));
process.on('SIGINT',()=>void close().finally(()=>process.exit(0)));
try{
 const started=performance.now();
 await local.transcribe(Buffer.alloc(96000),options,cancel.signal);
 send({ready:true,elapsedMs:Math.round(performance.now()-started)});
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
 for await(const line of lines){
  if(line.length>300000)throw new Error('frame too large');
  const item=JSON.parse(line),raw=Buffer.from(item.pcm,'base64');
  if(raw.length<6400||raw.length>16000*2*6||raw.length%2)throw new Error('invalid PCM');
  // The reused BotIn adapter accepts 48 kHz mono int16 PCM.
  const pcm=Buffer.alloc(raw.length*3);
  for(let i=0;i<raw.length;i+=2)for(let j=0;j<3;j++)pcm.writeInt16LE(raw.readInt16LE(i),i*3+j*2);
  try{
   const result=await local.transcribe(pcm,options,cancel.signal,vocabulary);
   send({id:item.id,target:matchWakeTarget(result.text,targets),length:result.text.length,...(item.detail?{text:result.text.slice(0,500)}:{}),elapsedMs:Math.round(result.elapsedMs)});
  }catch{if(!closing)send({id:item.id,error:'local_transcription_failed'});}
 }
}catch{if(!closing)send({error:'local_worker_failed'});process.exitCode=1;}
finally{await close();}
