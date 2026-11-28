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
const dayTotals = z.object({ confirmedMs: count, provisionalMs: count, breakMs: count }).strict()
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
    totals: dayTotals,
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
const proposalIdentity = z.object({
    companyId: employeeId, cif: z.string(), userName: z.string(), apiBaseUrl: z.string().url(),
}).strict()
export const proposalEnvelope = z.object({
    schemaVersion: z.literal(1),
    identity: proposalIdentity,
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

const reportDate = date.refine(value => value >= '1000-01-01' && value <= '9998-12-31')
const reportEmployees = z.array(employeeId).max(500)
    .refine(ids => new Set(ids).size === ids.length, 'Indica cada empleado una sola vez.')
export const reportFilter = z.object({
    from: reportDate,
    until: reportDate,
    employeeIds: reportEmployees.optional(),
    center: z.object(centerFields).strict().optional(),
}).strict()
export const reportRequest = z.object({ requestId, filter: reportFilter }).strict()
export const reportSummary = z.object({
    from: reportDate, until: reportDate, zone, asOf: timestamp, canExport: z.boolean(),
    rows: z.array(z.object({
        employeeId, name: z.string(), dayCount: count, byStatus: z.record(dayStatus, count), totals: dayTotals,
    }).strict()).max(500),
    totals: dayTotals,
}).strict()
export const reportReview = z.object({
    requestId,
    filter: reportFilter.extend({ employeeIds: reportEmployees, center: reportFilter.shape.center.nullable() }),
    employeeCount: count.max(500), asOf: timestamp, digest: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: timestamp,
}).strict()
export const reportEnvelope = z.object({
    schemaVersion: z.literal(1), identity: proposalIdentity, review: reportReview.extend({ proof: reviewFields.shape.proof }),
}).strict()
export const reportReceipt = z.object({
    requestId, status: z.enum(['NOT_OBSERVED', 'QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED']),
    from: reportDate.nullish(), until: reportDate.nullish(), asOf: timestamp.nullish(),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullish(),
}).strict()
export const reportXlsx = z.object({
    requestId, filename: z.string().regex(/^presencia-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/), bytes: count.positive(),
}).strict()

const archiveCursor = z.string().min(1).max(4096)
const archiveKind = z.enum(['RECEIPT', 'DECISION'])
const archiveSHA256 = z.string().regex(/^[a-f0-9]{64}$/)
const archiveUUID = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
export const maxArchiveOriginalBytes = 128 << 10
const archivedDay = z.object({
    workDate: reportDate, originalCount: z.union([z.literal(0), z.number().int().min(2).max(1024)]),
}).strict()
const archivedOriginal = z.object({
    kind: archiveKind, id: archiveUUID, eventId: archiveUUID, keyId: archiveUUID, sha256: archiveSHA256,
    revision: z.string().regex(/^[1-9][0-9]{0,19}$/), origin: z.enum(['TERMINAL', 'EMPLOYEE', 'MANUAL']),
}).strict()

export const archiveFilter = z.object({
    employeeId, from: reportDate, until: reportDate, cursor: archiveCursor.optional(), limit: z.number().int().min(1).max(100).optional(),
}).strict()
export const archiveSubject = z.object({ employeeId, date: reportDate }).strict()
export const archiveOriginalInput = archiveSubject.extend({ kind: archiveKind, originalId: requestId })
export const archivePage = z.object({
    employeeId, days: z.array(archivedDay).max(100), nextCursor: archiveCursor.nullish(),
}).strict()

const archiveTime = z.string().max(32).nullable()
const archiveText = z.string().max(64).nullable()
const archiveCenter = z.object(centerFields).strict()
const classicMovement = z.object({
    punchId: z.number().int().safe(), civilTime: archiveTime, occurredAtUtc: archiveTime, action: archiveText, method: archiveText,
    effective: z.boolean(), originalPunchId: z.number().int().safe().nullable(), correctedBy: archiveText,
    ruleCenter: archiveCenter, observedCenter: archiveCenter,
    audit: z.object({ createdBy: archiveText, createdAt: archiveTime, updatedBy: archiveText, updatedAt: archiveTime }).strict(),
}).strict()
const classicSummary = z.object({
    firstClockIn: archiveTime, lastClockOut: archiveTime, totalWorkMins: z.number().int(), totalBreakMins: z.number().int(),
    effectiveMins: z.number().int(), expectedMins: z.number().int(), deviationMins: z.number().int(),
    status: z.string().max(64), punches: z.number().int(),
}).strict()
export const archiveDay = z.object({
    employeeId, day: archivedDay, originals: z.array(archivedOriginal).max(1024),
    classic: z.object({ movements: z.array(classicMovement).max(2048), summary: classicSummary }).strict().optional(),
}).strict()
export const archiveOriginalFile = archiveSubject.extend({
    kind: archiveKind, id: archiveUUID, filename: z.string(), bytes: z.number().int().min(1).max(maxArchiveOriginalBytes),
    sha256: archiveSHA256,
})
