/** Mirrors signal/envelope.go — must stay in sync with the Go server (protocol.md §7.1). */

export interface Envelope {
  type: string
  sessionId?: string
  depotId?: string
  clientId?: string
  reason?: string
  payload?: unknown
}

export const TypeHello = 'hello'
export const TypeJoin = 'join'
export const TypeRegister = 'register'
export const TypeConnect = 'connect'
export const TypeRevoke = 'revoke'
export const TypeWatch = 'watch'

export const TypeSessionCreated = 'session_created'
export const TypePeerJoined = 'peer_joined'
export const TypePeerLeft = 'peer_left'
export const TypeIncoming = 'incoming'
export const TypeError = 'error'
/** Signal -> a watching Client: the Depot it asked about just registered. */
export const TypeDepotOnline = 'depot_online'

export const ReasonSessionExpired = 'session_expired'
export const ReasonSessionFull = 'session_full'
export const ReasonSessionNotFound = 'session_not_found'
export const ReasonDepotOffline = 'depot_offline'
export const ReasonClientRevoked = 'client_revoked'
export const ReasonRateLimited = 'rate_limited'
export const ReasonNoRoute = 'no_route'
export const ReasonBadEnvelope = 'bad_envelope'
export const ReasonAlreadyConnected = 'already_connected'
