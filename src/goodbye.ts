/** Only completed user goodbyes addressed to the current call's frozen names. */
const normalize=(value:string)=>value.normalize('NFKC').trim().toLowerCase().replace(/[\s,，.!。！]/gu,'');
const utterance=(text:string)=>normalize(text.replace(/^(?:(?:음|어|um|uh)[\s,.…]+)+/iu,''));
// Observed subscription ASR spellings. Names remain explicit; no fuzzy matching.
const prefixes=['bye','by','바이','바일','파일'];
export function isGoodbye(text:string,names:readonly string[]=['루미','Lumi']):boolean {
 const value=utterance(text);
 return names.some(name=>Boolean(normalize(name))&&prefixes.some(prefix=>{
  const command=normalize(prefix+name);
  return Boolean(value)&&value.length%command.length===0&&command.repeat(value.length/command.length)===value;
 }));
}

/** Full-duplex turn boundaries may split “Bye” from the addressed name. */
export class GoodbyeDetector {
 private prefixAt:number|null=null;
 reset(){this.prefixAt=null}
 accept(text:string,names:readonly string[],now=Date.now()):boolean {
  const value=utterance(text),prior=this.prefixAt;this.reset();
  if(isGoodbye(text,names))return true;
  // Never end on a prefix alone. Any intervening user sentence invalidates it.
  if(prefixes.includes(value)){this.prefixAt=now;return false}
  return prior!==null&&now>=prior&&now-prior<=3000&&Boolean(value)&&names.some(name=>normalize(name)===value);
 }
}
