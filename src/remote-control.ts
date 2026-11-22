import type { PluginFiles, Route } from '@hermes/plugin-sdk'
import { parseVoiceToken, type CallPhase } from './voice-command.ts'

export const CONTROL_PATH = '/hermes-live/control'
interface Target {
  connectionId: string
  profile: string
}
type Action = 'open' | 'start' | 'stop' | 'toggle'
export interface Command extends Target {
  action: Action
  nonce: string
}
type Reason =
  | 'bad_request'
  | 'bad_token'
  | 'auth_unavailable'
  | 'duplicate'
  | 'busy'
  | 'transitioning'
  | 'paused'
  | 'already_on'
  | 'already_off'
  | 'wrong_bot'
  | 'unsupported_sdk'
  | 'unknown_connection'
  | 'unknown_profile'
  | 'route_unavailable'
  | 'open_failed'
  | 'scope_changed'
  | 'switch_failed'
  | 'start_failed'
  | 'stop_failed'
export class ControlError extends Error {
  readonly code: Reason
  constructor(code: Reason) {
    super(code)
    this.code = code
  }
}
export function refuse(code: Reason): never {
  throw new ControlError(code)
}
const actions = new Set(['open', 'start', 'stop', 'toggle'])
function parse(location: string): Command {
  const prefix = '#' + CONTROL_PATH + '?'
  if (!location.startsWith(prefix)) refuse('bad_request')
  const p = new URLSearchParams(location.slice(prefix.length))
  if (
    p.size !== 6 ||
    !['v', 'action', 'connectionId', 'profile', 'nonce', 'token'].every((k) => p.has(k)) ||
    p.get('v') !== '2'
  )
    refuse('bad_request')
  const action = p.get('action')!,
    connectionId = p.get('connectionId')!,
    profile = p.get('profile')!,
    nonce = p.get('nonce')!
  if (
    !actions.has(action) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(connectionId) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ||
    !/^[0-9a-f]{32}$/.test(nonce)
  )
    refuse('bad_request')
  return { action: action as Action, connectionId, profile, nonce }
}

// Only this local SDK file adapter sees the URL. The callback receives a credential-free command.
export async function runRemoteControl(
  location: string,
  instance: string,
  files: PluginFiles | undefined,
  now: () => number,
  execute: (cmd: Command) => Promise<void>
): Promise<Reason | null> {
  try {
    const command = parse(location),
      token = parseVoiceToken(location)
    if (!token) refuse('bad_token')
    if (!files?.readText || !files.writeText) refuse('auth_unavailable')
    const request = await files.readText('data', `request-${command.nonce}.json`)
    if (!request.ok) refuse('auth_unavailable')
    const ticket = JSON.parse(request.text)
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const time = now()
    if (
      ticket?.v !== 2 ||
      ticket.instance !== instance ||
      ticket.connectionId !== command.connectionId ||
      ticket.profile !== command.profile ||
      ticket.action !== command.action ||
      !Number.isSafeInteger(ticket.expiresAt) ||
      ticket.expiresAt <= time ||
      ticket.expiresAt > time + 30000 ||
      ticket.sha256 !== digest
    )
      refuse('bad_token')
    const result = (outcome: string, reason: Reason | null) =>
      JSON.stringify({ v: 2, instance, ...command, at: now(), outcome, reason })
    const path = `result-${command.nonce}.json`
    const claim = await files.writeText('data', path, result('pending', null), { exclusive: true })
    if (!claim.ok) refuse(claim.error === 'exists' ? 'duplicate' : 'auth_unavailable')
    let reason: Reason | null = null
    try {
      if (now() >= ticket.expiresAt) refuse('bad_token')
      await execute(command)
    } catch (error) {
      reason = error instanceof ControlError ? error.code : 'open_failed'
    }
    const failed =
      reason &&
      ['route_unavailable', 'open_failed', 'switch_failed', 'start_failed', 'stop_failed'].includes(reason)
    const written = await files.writeText(
      'data',
      path,
      result(reason ? (failed ? 'failed' : 'rejected') : 'accepted', reason)
    )
    return written.ok ? reason : 'auth_unavailable'
  } catch (error) {
    return error instanceof ControlError ? error.code : 'auth_unavailable'
  }
}

interface Registry {
  connections(): Promise<{ id: string; kind: string }[]>
  routes(): Promise<Route[]>
  probe(seed: Route): Promise<unknown>
}
export async function resolveRemoteRoute(registry: Registry, target: Target): Promise<Route> {
  try {
    const source = (await registry.connections()).find((s) => s.id === target.connectionId)
    if (!source || !['ssh', 'remote', 'cloud'].includes(source.kind)) refuse('unknown_connection')
    const matchingSource = (r: Route) => r.connectionId === source.id && r.mode === 'remote'
    let routes = (await registry.routes()).filter(matchingSource)
    if (
      source.kind === 'ssh' &&
      routes.length === 1 &&
      routes[0].profile === 'default' &&
      target.profile !== 'default'
    ) {
      await registry.probe(routes[0])
      routes = (await registry.routes()).filter(matchingSource)
    }
    const exact = routes.filter((r) => r.profile === target.profile && r.targetProfile)
    if (exact.length !== 1) refuse('unknown_profile')
    return exact[0]
  } catch (error) {
    if (error instanceof ControlError) throw error
    refuse('route_unavailable')
  }
}

export interface ControlState {
  status: CallPhase
  owner: Target | null
  busy: boolean
  paused: boolean
  transitioning: boolean
}
export function remoteOperation(action: Action, target: Target, state: ControlState) {
  const { status, owner } = state
  if (status === 'unknown' || status === 'connecting' || state.transitioning) refuse('transitioning')
  const op = action === 'toggle' ? (status === 'in_call' ? 'stop' : 'start') : action
  if (op === 'stop') {
    if (status === 'off') refuse('already_off')
    if (owner?.connectionId !== target.connectionId || owner.profile !== target.profile) refuse('wrong_bot')
  } else {
    if (status === 'in_call') refuse('already_on')
    if (state.busy) refuse('busy')
    if (op === 'start' && state.paused) refuse('paused')
  }
  return op
}
