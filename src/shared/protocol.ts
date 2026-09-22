import { z } from 'zod'

export const DaemonPhaseSchema = z.enum([
  'UNINSTALLED',
  'IDLE',
  'PROBING',
  'ACTIVE',
  'NETWORK_SETTLING',
  'REPAIRING',
  'PAUSED',
  'DEGRADED'
])

export const ManagedItemStateSchema = z.enum([
  'unknown',
  'missing',
  'correct',
  'drifted'
])

export const RouteStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  destination: z.string().min(1),
  interface: z.string().nullable(),
  gateway: z.string().nullable(),
  state: ManagedItemStateSchema
}).strict()

export const DnsStatusSchema = z.object({
  state: ManagedItemStateSchema,
  servers: z.array(z.string()),
  domains: z.array(z.string()),
  resolvedAddresses: z.array(z.string())
}).strict()

export const DaemonErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  occurredAt: z.iso.datetime(),
  retryable: z.boolean()
}).strict()

export const DiagnosticEventSchema = z.object({
  id: z.string().min(1),
  occurredAt: z.iso.datetime(),
  level: z.enum(['info', 'warning', 'error']),
  code: z.string().min(1),
  message: z.string().min(1)
}).strict()

export const DaemonStatusSchema = z.object({
  schemaVersion: z.literal(1),
  phase: DaemonPhaseSchema,
  message: z.string(),
  updatedAt: z.iso.datetime(),
  physicalInterface: z.string().nullable(),
  physicalGateway: z.string().nullable(),
  mobileInterface: z.string().nullable(),
  routes: z.array(RouteStatusSchema),
  dns: DnsStatusSchema,
  lastCheckAt: z.iso.datetime().nullable(),
  lastNetworkChangeAt: z.iso.datetime().nullable(),
  lastError: DaemonErrorSchema.nullable(),
  autoEnableAtBoot: z.boolean(),
  paused: z.boolean(),
  logLevel: z.enum(['standard', 'detailed']).optional(),
  daemonVersion: z.string().nullable(),
  processedRequestId: z.uuid().nullable(),
  events: z.array(DiagnosticEventSchema).max(200)
}).strict()

const requestBase = z.object({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  createdAt: z.iso.datetime()
})

export const ControlRequestSchema = z.discriminatedUnion('type', [
  requestBase.extend({ type: z.literal('repairNow') }).strict(),
  requestBase.extend({ type: z.literal('setPaused'), value: z.boolean() }).strict(),
  requestBase.extend({ type: z.literal('setAutoEnableAtBoot'), value: z.boolean() }).strict(),
  requestBase.extend({
    type: z.literal('setLogLevel'),
    value: z.enum(['standard', 'detailed'])
  }).strict()
])

export type DaemonPhase = z.infer<typeof DaemonPhaseSchema>
export type ManagedItemState = z.infer<typeof ManagedItemStateSchema>
export type RouteStatus = z.infer<typeof RouteStatusSchema>
export type DnsStatus = z.infer<typeof DnsStatusSchema>
export type DaemonError = z.infer<typeof DaemonErrorSchema>
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>
export type ControlRequest = z.infer<typeof ControlRequestSchema>
