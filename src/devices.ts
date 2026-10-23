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
