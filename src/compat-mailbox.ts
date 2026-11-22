import type {PluginFiles} from '@hermes/plugin-sdk'

export const MAILBOX_PATH = '/api/plugins/hermes-live/control-mailbox'
export const PAIRING_FILE = 'hermes-live-switchboard.key'

export function localMailboxUrl(address: string) {
  const url = new URL(address)
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== MAILBOX_PATH || url.hash) throw Error('Local Desktop unavailable')
  url.search = ''
  return url.toString()
}
export function controlFiles(native: PluginFiles | undefined, legacy: () => PluginFiles): PluginFiles {
  if (typeof native?.readText !== 'function' || typeof native.writeText !== 'function') return legacy()
  let fallback: PluginFiles | undefined
  async function run<T extends {ok:boolean; error?:string}>(op:(files:PluginFiles)=>Promise<T>) {
    if (fallback) return op(fallback)
    const result = await op(native!)
    // This exact SDK result means the Electron file door never ran. Never retry an ambiguous write.
    if (result.ok || result.error !== 'unavailable') return result
    fallback ??= legacy()
    return op(fallback)
  }
  return {
    readText: (...args) => run(files=>files.readText(...args)),
    writeText: (...args) => run(files=>files.writeText(...args))
  }
}

function joined(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}
const utf8 = new TextEncoder()
export async function exchange(url: string, key: CryptoKey, packet: object) {
  const socket = new WebSocket(localMailboxUrl(url))
  socket.binaryType = 'arraybuffer'
  return new Promise<{ok: true; text?: string} | {ok: false; error: string}>((resolve, reject) => {
    const timeout = setTimeout(() => done(), 5000)
    let challenge: Uint8Array | undefined
    const iv = crypto.getRandomValues(new Uint8Array(12))
    function done(result?: {ok:true; text?:string} | {ok:false; error:string}) {
      clearTimeout(timeout)
      socket.onclose = socket.onmessage = socket.onerror = null
      socket.close()
      if (result) resolve(result)
      else reject(Error('Local Desktop unavailable'))
    }
    socket.onerror = socket.onclose = () => done()
    socket.onmessage = async event => {
      try {
        if (!(event.data instanceof ArrayBuffer)) throw Error()
        const bytes = new Uint8Array(event.data)
        if (!challenge) {
          if (bytes.length !== 16) throw Error()
          challenge = bytes
          const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:joined(utf8.encode('hermes-live/request'),challenge)}, key, utf8.encode(JSON.stringify(packet)))
          socket.send(joined(iv,new Uint8Array(encrypted)))
        } else {
          if (bytes.length < 28 || bytes.length > 8192) throw Error()
          const decoded = await crypto.subtle.decrypt({name:'AES-GCM', iv:bytes.slice(0,12), additionalData:joined(utf8.encode('hermes-live/result'),challenge,iv)}, key, bytes.slice(12))
          const value = JSON.parse(new TextDecoder().decode(decoded))
          if (typeof value?.ok !== 'boolean') throw Error()
          done(value)
        }
      } catch { done() }
    }
  })
}

interface LocalGrant {key:CryptoKey; url?:string}
export async function parseGrant(file:File): Promise<LocalGrant> {
  if(file.size > 256) throw Error('Invalid pairing file')
  let raw = await file.text()
  let url: string | undefined
  if (file.name === 'hermes-live-connector.key') {
    const grant = JSON.parse(raw)
    if (!grant || grant.v !== 1 || Object.keys(grant).sort().join() !== 'key,port,v' ||
        !Number.isInteger(grant.port) || grant.port < 1024 || grant.port > 65535) throw Error('Invalid connector file')
    url = 'ws://127.0.0.1:'+grant.port+MAILBOX_PATH
    raw = grant.key
  } else if (file.name !== PAIRING_FILE) throw Error('Invalid pairing file')
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) throw Error('Invalid pairing file')
  const key = await crypto.subtle.importKey('raw',Uint8Array.from(raw.match(/../g)!,c=>parseInt(c,16)), 'AES-GCM',false,['encrypt','decrypt'])
  return {key,url}
}

// Structured cloning preserves the key's non-extractable flag across Desktop launches.
async function savedKey(write?: LocalGrant): Promise<LocalGrant | undefined> {
  return new Promise((resolve,reject) => {
    const open = indexedDB.open('hermes-live-switchboard',1)
    open.onupgradeneeded = () => open.result.createObjectStore('pairing')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('pairing',write?'readwrite':'readonly')
      const store = tx.objectStore('pairing')
      const request = write ? store.put(write,'key') : store.get('key')
      tx.oncomplete = () => { db.close(); resolve(write ?? request.result) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}
export function legacyMailbox(resolveLocal: () => Promise<string>) {
  let grant: LocalGrant | undefined
  let url: string | undefined
  let checkedAt = -Infinity
  const send = async (packet: object) => {
    try {
      if (!grant && performance.now()-checkedAt > 5000) {
        checkedAt = performance.now()
        grant = await savedKey()
      }
      if (!grant) throw Error()
      url ??= grant.url ?? localMailboxUrl(await resolveLocal())
      return await exchange(url, grant.key, packet)
    } catch {
      url = undefined
      grant = undefined
      return {ok:false as const,error:'unavailable'}
    }
  }
  const files: PluginFiles = {
    async readText(_folder, path) {
      const result = await send({op:'read',path})
      return result.ok && typeof result.text === 'string' ? {ok:true,text:result.text} : {ok:false,error:'unavailable'}
    },
    writeText: (_folder,path,text,options) => send({op:'write',path,text,exclusive:Boolean(options?.exclusive)})
  }
  return {
    files,
    async pair(file: File) {
      const imported = await parseGrant(file)
      // Only a service holding this file's key can answer the no-side-effect verification.
      const local = imported.url ?? localMailboxUrl(await resolveLocal())
      if (!(await exchange(local,imported.key,{op:'verify'})).ok) throw Error('Pairing failed')
      await savedKey(imported)
      grant = imported
      url = local
    }
  }
}
