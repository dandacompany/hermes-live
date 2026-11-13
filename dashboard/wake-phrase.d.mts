export function matchesWakePhrase(text:string,phrase:string):boolean;
export function matchWakeTarget(text:string,targets:readonly {target:string;phrases:readonly string[]}[]):string|null;
