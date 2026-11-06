export interface AudioDevices {input:string;output:string}
export const defaultDevices:AudioDevices={input:'',output:''};
export function microphoneConstraints(input=''):MediaStreamConstraints {
 return {audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(input?{deviceId:{exact:input}}:{})},video:false};
}
export async function routeOutput(context:AudioContext,output=''){
 if(!output)return;
 const sink=context as AudioContext & {setSinkId?:(id:string)=>Promise<void>};
 if(!sink.setSinkId)throw new Error("HL_ERROR:errSpeakerUnsupported");
 try{await sink.setSinkId(output)}catch{throw new Error("HL_ERROR:errSpeakerMissing")}
}
export function audioDeviceError(error:unknown){
 const name=(error as {name?:string})?.name;
 if(name==='OverconstrainedError'||name==='NotFoundError')return "HL_ERROR:errMicMissing";
 if(name==='NotAllowedError')return "HL_ERROR:errMicPermission";
 return error instanceof Error?error.message:"HL_ERROR:errAudio";
}

/** macOS and Chromium name the same USB mic differently; never select an alias or fallback. */
export function selectWakeMicrophone(devices:readonly MediaDeviceInfo[],name:string):MediaDeviceInfo {
 const canonical=(label:string)=>label.trim().replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i,'');
 const concrete=new Map(devices.filter(d=>d.kind==='audioinput'&&d.deviceId&&!['default','communications'].includes(d.deviceId)).map(d=>[d.deviceId,d]));
 // Apple Virtualization exposes one input under different Core Audio/Chromium names.
 // Restrict this alias to that exact pair and one concrete input; never guess a USB mic.
 const virtual=concrete.size===1&&name==='Apple Virtual Sound Device'&&[...concrete.values()][0]?.label==='Microphone (Built-in)';
 const matches=new Map([...concrete].filter(([,d])=>canonical(d.label)===canonical(name)||virtual));
 if(matches.size!==1)throw new Error('HL_ERROR:errMicMissing');
 return [...matches.values()][0]!;
}

export function canonicalMicrophoneLabel(label:string){return label.replace(/^(Default|기본값)\s*-\s*/i,'').trim().replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i,'')}
