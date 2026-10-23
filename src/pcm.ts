export function pcm16(samples: Float32Array): string {
 const bytes=new Uint8Array(samples.length*2); const view=new DataView(bytes.buffer);
 for(let i=0;i<samples.length;i++){const n=Math.max(-1,Math.min(1,samples[i]!));view.setInt16(i*2,Math.round(n*(n<0?32768:32767)),true)}
 let s=''; for(const byte of bytes)s+=String.fromCharCode(byte); return btoa(s);
}
export function decodePCM(data:string):Float32Array {
 const text=atob(data); if(text.length%2)throw new Error("HL_ERROR:errProtocol");
 const bytes=Uint8Array.from(text,c=>c.charCodeAt(0));const view=new DataView(bytes.buffer);const out=new Float32Array(bytes.length/2);
 for(let i=0;i<out.length;i++)out[i]=view.getInt16(i*2,true)/32768;return out;
}
