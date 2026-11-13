/** Match whole utterances; names are explicit aliases, never substring substitutions. */
const normalize=value=>value.normalize('NFKC').toLowerCase().replace(/[\s,，.!。！]/gu,'');
export function matchesWakePhrase(text,phrase){
 const value=normalize(text),command=normalize(phrase);
 // ASR can combine repeated calls into one turn. Accept only whole repetitions.
 return Boolean(value&&command)&&value.length%command.length===0&&command.repeat(value.length/command.length)===value;
}
export function matchWakeTarget(text,targets){
 const ids=new Set(targets.filter(t=>t.phrases.some(p=>matchesWakePhrase(text,p))).map(t=>t.target));
 return ids.size===1?[...ids][0]:null;
}
