/** Only standalone user goodbyes addressed to the current call's frozen names. */
export function isGoodbye(text:string,names:readonly string[]=['루미','Lumi']):boolean {
 const normalize=(value:string)=>value.normalize('NFKC').trim().toLowerCase().replace(/[\s,，.!。！]/gu,'');
 const value=normalize(text.replace(/^(?:(?:음|어|um|uh)[\s,.…]+)+/iu,''));
 // Observed Korean ASR renders Bye as 바일/파일; retain exact name and whole-turn matching.
 return names.some(name=>['Bye','바이','바일','파일'].some(prefix=>normalize(prefix+name)===value));
}
