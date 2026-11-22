import type { host as desktop } from '@hermes/plugin-sdk'
import type { Scope } from './hermes-bridge.ts'
import { openCanonicalBot, wakeBotReady } from './wake-navigation.ts'
import {
  ControlError,
  refuse,
  remoteOperation,
  resolveRemoteRoute,
  type Command,
  type ControlState
} from './remote-control.ts'

interface Live {
  scope(): Scope
  status(): ControlState
  callIdentity(): unknown
  withLocalWakeReleased(activate: () => Promise<void>): Promise<void>
  start(scope: Scope): Promise<void>
  stop(): void
}
export function remoteDesktop(host: typeof desktop, live: Live, hash: () => string) {
  let working = false,
    disposed = false
  const supported = () =>
    Boolean(
      typeof host.activeConnectionId === 'function' &&
      typeof host.connections === 'function' &&
      typeof host.profileRoutes === 'function' &&
      typeof host.requestProfile === 'function' &&
      typeof host.openSession === 'function' &&
      typeof host.ensureAgent === 'function' &&
      typeof host.revealPane === 'function' &&
      typeof host.paneVisibility === 'function' &&
      host.state.focusedStoredSessionId
    )
  function capture() {
    const arrival = hash(),
      state = live.status(),
      identity = live.callIdentity()
    return async (command: Command) => {
      if (working) refuse('busy')
      working = true
      try {
        const stillIdleOrSameCall = () =>
          !disposed && live.status().status === state.status && live.callIdentity() === identity
        const atCommand = () => hash() === arrival && stillIdleOrSameCall()
        if (!atCommand()) refuse('scope_changed')
        const op = remoteOperation(command.action, command, state)
        if (!supported()) refuse('unsupported_sdk')
        const route = await resolveRemoteRoute(
          {
            connections: () => host.connections!(),
            routes: () => host.profileRoutes(),
            probe: (seed) =>
              host.requestProfile(seed, 'profiles.list', { include_sessions: false }, undefined, {
                spawnPriority: 'foreground'
              })
          },
          command
        )
        if (!atCommand()) refuse('scope_changed')
        remoteOperation(op, command, live.status())
        if (op === 'stop') {
          try {
            live.stop()
          } catch {
            refuse('stop_failed')
          }
          return
        }
        // The canonical main-session open navigates to this exact stored id. Any other
        // departure from the command route supersedes our authority to change focus.
        let landing: string | null = null
        const selected = (stored: string) =>
          wakeBotReady(
            live.scope(),
            route.profile,
            route.connectionId,
            stored,
            host.state.focusedStoredSessionId!.get()
          )
        const onChat = () =>
          landing !== null && hash() === `#/${encodeURIComponent(landing)}` && selected(landing)
        const current = () => stillIdleOrSameCall() && (hash() === arrival || onChat())
        let stored: string
        try {
          stored = await openCanonicalBot(
            {
              retain: host.retainProfile && (r => host.retainProfile!(r, { spawnPriority: 'foreground' })),
              request: (r, m, p) => host.requestProfile(r, m, p, undefined, { spawnPriority: 'foreground' }),
              isSelected: selected,
              revealPane: host.revealPane,
              paneVisible: (id) => host.paneVisibility!(id).get(),
              label: host.setWorkspaceOwnerLabel,
              openSession: (id, options) => {
                landing = id
                return host.openSession!(id, options)
              }
            },
            route,
            route.profile,
            current
          )
        } catch (error) {
          if (!current()) refuse('scope_changed')
          if (error instanceof Error && error.message === 'HL_ERROR:errBotsView') refuse('unsupported_sdk')
          refuse('open_failed')
        }
        if (!onChat() || !selected(stored)) refuse('scope_changed')
        if (op === 'open') return
        remoteOperation(op, command, live.status())
        const backendMatches = () =>
          host.activeConnectionId!() === route.connectionId &&
          host.state.connectionId.get() === route.connectionId &&
          host.state.profile.get() === route.profile
        if (!backendMatches()) {
          try {
            await live.withLocalWakeReleased(async () => {
              if (!current() || !onChat()) refuse('scope_changed')
              remoteOperation(op, command, live.status())
              await host.ensureAgent(route.connectionId, route.profile)
            })
          } catch (error) {
            if (error instanceof ControlError) throw error
            refuse('switch_failed')
          }
        }
        if (!current() || !onChat() || !backendMatches()) refuse('scope_changed')
        remoteOperation(op, command, live.status())
        try {
          await live.start(live.scope())
        } catch (error) {
          if (error instanceof ControlError) throw error
          refuse('start_failed')
        }
        const active = live.status()
        if (
          !onChat() ||
          active.status !== 'in_call' ||
          active.owner?.connectionId !== route.connectionId ||
          active.owner.profile !== route.profile
        )
          refuse('start_failed')
      } finally {
        working = false
      }
    }
  }
  return {
    capture,
    supported,
    dispose: () => {
      disposed = true
    }
  }
}
