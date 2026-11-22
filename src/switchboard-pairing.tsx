import React, {useState} from 'react'
import {Button} from '@hermes/plugin-sdk'

export function SwitchboardPairing({korean,local,prepare,pair}:{korean:boolean;local:boolean;prepare:()=>Promise<{file:string}>;pair:(file:File)=>Promise<void>}) {
  const [filePath,setPath] = useState('')
  const [note,setNote] = useState('')
  const failed = () => setNote(korean?'연결할 수 없습니다. 이 기기의 기본 프로필에서 페어링 파일을 다시 준비하세요.':'Could not pair. Prepare the file from this device’s default profile and try again.')
  return <section>
    <h3>Switchboard</h3>
    <p>{korean?'이 Desktop에서 외부 키로 원격 대화와 통화를 제어하려면 로컬 파일을 한 번 연결하세요.':'To control remote chats and calls from external keys on this Desktop, pair the local file once.'}</p>
    <Button disabled={!local} onClick={async()=>{try{setPath((await prepare()).file);setNote('')}catch{failed()}}}>{korean?'페어링 파일 준비':'Prepare pairing file'}</Button>
    {!local && <p>{korean?'파일은 이 기기의 기본 프로필에서 준비할 수 있습니다. 독립 커넥터를 실행했다면 터미널에 표시된 페어링 파일을 선택하세요.':'Prepare a file from this device’s default profile, or select the file printed by your local foreground connector.'}</p>}
    {filePath && <p><code>{filePath}</code></p>}
    <label>{korean?'로컬 페어링 파일 선택':'Select local pairing file'} <input type="file" accept=".key" onChange={async event=>{
      const file=event.currentTarget.files?.[0]
      event.currentTarget.value=''
      if(!file) return
      try{await pair(file);setNote(korean?'이 Desktop을 연결했습니다.':'This Desktop is paired.')}catch{failed()}
    }}/></label>
    {note && <p role="status">{note}</p>}
  </section>
}
