import { idbGet, idbSet } from './idb'

/** Depot side, protocol.md §3.5: one record per paired Client. */
export interface DeviceRecord {
  clientIdentityPub: string // base64
  label: string
  createdAt: number
  lastSeenAt: number
  revoked: boolean
}

const KEY = 'depot:devices'

export async function listDevices(): Promise<DeviceRecord[]> {
  return (await idbGet<DeviceRecord[]>(KEY)) ?? []
}

export async function saveDevice(device: DeviceRecord): Promise<void> {
  const devices = await listDevices()
  const next = devices.filter((d) => d.clientIdentityPub !== device.clientIdentityPub)
  next.push(device)
  await idbSet(KEY, next)
}

export async function getDevice(clientIdentityPub: string): Promise<DeviceRecord | undefined> {
  return (await listDevices()).find((d) => d.clientIdentityPub === clientIdentityPub)
}

export async function revokeDevice(clientIdentityPub: string): Promise<void> {
  const device = await getDevice(clientIdentityPub)
  if (!device) return
  await saveDevice({ ...device, revoked: true })
}

export async function touchDevice(clientIdentityPub: string): Promise<void> {
  const device = await getDevice(clientIdentityPub)
  if (!device) return
  await saveDevice({ ...device, lastSeenAt: Date.now() })
}
