/** Match whole utterances; names are explicit aliases, never substring substitutions. */
const normalize=value=>value.normalize('NFKC').toLowerCase().replace(/[\s,，.!。！]/gu,'');
export function matchesWakePhrase(text,phrase){return Boolean(text.trim())&&normalize(text)===normalize(phrase)}
export function matchWakeTarget(text,targets){
 const ids=new Set(targets.filter(t=>t.phrases.some(p=>matchesWakePhrase(text,p))).map(t=>t.target));
 return ids.size===1?[...ids][0]:null;
}
