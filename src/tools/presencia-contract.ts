import { z } from 'zod'

export const requestId = z.string().uuid().transform(value => value.toLowerCase())
const identifier = z.number().int().nonnegative().max(2147483647)
export const employeeId = identifier.min(1)
const date = z.string().date()
const timestamp = z.string().datetime({ offset: true })
const revision = z.string().min(1).max(128)
const action = z.enum(['ENTRY', 'START_BREAK', 'END_BREAK', 'EXIT'])
const centerFields = { clientId: identifier, centerId: identifier }
const place = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('CENTER'), ...centerFields }).strict(),
    z.object({ kind: z.literal('REMOTE') }).strict(),
])
const participation = z.object({
    effectiveFrom: date,
    mode: z.enum(['SCHEDULED', 'VOLUNTARY', 'INACTIVE']),
    allowRemote: z.boolean(),
    requireGps: z.boolean(),
    centers: z.array(z.object(centerFields).strict()),
})
export const configurationChange = participation.extend({ requestId, revision }).strict()
export const assistedPunch = z.object({
    requestId, employeeId, action, place, reason: z.string().min(1).max(500),
}).strict()

export const configuration = z.object({
    employeeId, revision,
    periods: z.array(participation.extend({ effectiveUntil: date.nullish() }).strict()),
}).strict()

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const cursor = z.string().min(1).max(4096)
const zone = z.string().min(1).max(50)
const reason = z.string().min(1).max(500).regex(/\S/)
const dayStatus = z.enum(['OFF', 'WORKING', 'ON_BREAK', 'CLOSED', 'JUSTIFIED', 'MISSING', 'OPEN_LATE', 'ERROR'])
const requestStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED'])
const correctionKind = z.enum(['ADD', 'REPLACE', 'VOID', 'REVERT'])
const pagination = { cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional() }
const schedule = z.object({
    kind: z.enum(['SHIFT', 'REST', 'PENDING', 'HOLIDAY', 'ABSENCE']),
    zone, start: timestamp.nullish(), end: timestamp.nullish(),
}).strict()
const punch = z.object({ action, at: timestamp }).strict()
const dayRequest = z.object({
    id: requestId, employeeId, workDate: date, reason, createdAt: timestamp, status: requestStatus,
    resolvedAt: timestamp.nullish(), resolutionReason: reason.nullish(),
}).strict()

export const daySubject = z.object({ employeeId, date }).strict()
export const daysFilters = z.object({
    date: date.optional(),
    q: z.string().optional(),
    clientId: identifier.optional(),
    centerId: identifier.optional(),
    view: z.enum(['ALL', 'PENDING', 'REQUESTS']).optional(),
    status: dayStatus.optional(),
    ...pagination,
}).strict()
export const requestsFilters = z.object({
    date: date.optional(), employeeId: employeeId.optional(), status: requestStatus.optional(), ...pagination,
}).strict()

export const officeDays = z.object({
    date, zone, asOf: timestamp,
    rows: z.array(z.object({
        employeeId, name: z.string(), status: dayStatus,
        schedule: schedule.nullish(), lastPunch: punch.nullish(), pendingRequests: count,
    }).strict()),
    counts: z.object({ total: count, byStatus: z.record(dayStatus, count) }).strict(),
    nextCursor: cursor.nullish(),
}).strict()
export const day = z.object({
    employeeId, name: z.string(), workDate: date, zone, revision, status: dayStatus, schedule: schedule.nullish(),
    totals: z.object({ confirmedMs: count, provisionalMs: count, breakMs: count }).strict(),
    movements: z.array(punch.extend({
        id: requestId, place, origin: z.enum(['OWN_PUNCH', 'ASSISTED_PUNCH', 'CORRECTION', 'REQUEST_RESOLVE']),
        effective: z.boolean(),
    }).strict()),
    corrections: z.array(z.object({
        id: requestId, kind: correctionKind, reason, createdAt: timestamp, createdBy: z.string().min(1).nullish(),
        active: z.boolean(), targetPunchId: requestId.nullish(), replacementPunchId: requestId.nullish(),
        replacementExitPunchId: requestId.nullish(), revertedCorrectionId: requestId.nullish(),
    }).strict()),
    requests: z.array(dayRequest),
    capabilities: z.object({ correct: z.boolean(), resolve: z.boolean() }).strict(),
    placeLabels: z.array(z.object({ ...centerFields, name: z.string().min(1) }).strict()).optional(),
}).strict()
export const requestsPage = z.object({ rows: z.array(dayRequest), nextCursor: cursor.nullish() }).strict()

const movement = z.object({
    action, at: z.string().datetime().regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3}0{0,6})?Z$/), place,
}).strict()
const singleMovementChange = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ADD'), movement }).strict(),
    z.object({ kind: z.literal('REPLACE'), punchId: requestId, movement }).strict(),
    z.object({ kind: z.literal('VOID'), punchId: requestId }).strict(),
    z.object({ kind: z.literal('REVERT'), revertId: requestId }).strict(),
])
const addClosedDay = z.object({
    kind: z.literal('ADD'),
    movement: movement.extend({ action: z.literal('ENTRY') }),
    exit: movement.extend({ action: z.literal('EXIT') }),
}).strict()
export const correctionChange = z.union([singleMovementChange, addClosedDay])
const changes = z.object({ requestId, expectedRevision: revision, reason }).strict()
export const correctionInput = changes.extend({ change: correctionChange })
const resolutionApproval = changes.extend({ decision: z.literal('APPROVED'), change: correctionChange })
const resolutionRejection = changes.extend({ decision: z.literal('REJECTED') })
export const resolutionInput = z.discriminatedUnion('decision', [resolutionApproval, resolutionRejection])
const resolutionProposal = z.discriminatedUnion('decision', [
    resolutionApproval.extend({ solicitudId: requestId }),
    resolutionRejection.extend({ solicitudId: requestId }),
])

const reviewFields = z.object({
    requestId, employeeId, workDate: date, revision,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    proof: z.string().min(1).max(16384),
    expiresAt: timestamp,
})
export const review = z.discriminatedUnion('kind', [
    reviewFields.extend({ kind: z.literal('CONFIGURE'), proposal: configurationChange }).strict(),
    reviewFields.extend({ kind: z.literal('ASSISTED_PUNCH'), proposal: assistedPunch }).strict(),
    reviewFields.extend({ kind: z.literal('CORRECTION'), proposal: correctionInput }).strict(),
    reviewFields.extend({ kind: z.literal('REQUEST_RESOLVE'), proposal: resolutionProposal }).strict(),
])
export const proposalEnvelope = z.object({
    schemaVersion: z.literal(1),
    identity: z.object({
        companyId: employeeId, cif: z.string(), userName: z.string(), apiBaseUrl: z.string().url(),
    }).strict(),
    review,
}).strict()
const b3ReceiptKind = z.enum(['CORRECTION', 'REQUEST_CREATE', 'REQUEST_RESOLVE'])
export const receipt = z.object({
    requestId,
    outcome: z.enum(['NOT_OBSERVED', 'CONFIRMED', 'REJECTED', 'CANCELLED']),
    kind: z.enum(['CONFIGURE', 'ASSISTED_PUNCH', 'OWN_PUNCH', ...b3ReceiptKind.options]).nullish(),
    code: z.string().nullish(),
    employeeId: employeeId.nullish(),
    workDate: date.nullish(),
    punch: punch.nullish(),
}).strict().refine(value => !b3ReceiptKind.safeParse(value.kind).success || value.punch == null)
