import { z } from 'zod'
import { employeeId, requestId } from './presencia-contract.js'

const date = z.string().date().refine(value => value >= '1000-01-01' && value <= '9998-12-31')
const instant = z.string().datetime({ offset: true })
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/)
const zone = z.string().min(1).max(50)
const identifier = z.number().int().nonnegative().max(2147483647)
const center = z.object({ clientId: identifier, centerId: identifier }).strict()
const employeeIds = z.array(employeeId).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'Indica cada empleado una sola vez.')
export const monday = date.refine(value => new Date(value + 'T00:00:00Z').getUTCDay() === 1, 'Indica el lunes de la semana.')

export const weekScope = z.object({
    week: monday,
    employeeIds: employeeIds.optional(),
    afterEmployeeId: employeeId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    search: z.string().max(160).optional(),
}).strict()

const action = z.enum(['SAVE_DRAFT', 'PUBLISH'])
const subject = z.object({ employeeId, date })
const shiftId = z.string().min(1).max(200)
const section = z.string().max(80).regex(/\S/)
const decision = z.discriminatedUnion('choice', [
    subject.extend({
        choice: z.literal('SHIFT'), shiftId, plannedCenter: center.optional(), section: section.optional(),
        paidBreakMinutes: identifier.optional(), unpaidBreakMinutes: identifier.optional(),
    }).strict(),
    subject.extend({ choice: z.enum(['REST', 'PENDING', 'DRAFT', 'COPY']) }).strict(),
])
export const rosterIntent = z.object({
    requestId, action, draftRevision: identifier, publishedRevision: identifier.min(1).nullable(),
    cells: z.array(decision).min(1).max(500),
    copyFromMonday: monday.optional(),
}).strict()

const value = z.object({
    kind: z.enum(['SHIFT', 'REST', 'PENDING', 'HOLIDAY', 'ABSENCE']),
    zone, start: instant.nullish(), end: instant.nullish(),
    paidBreakMinutes: identifier, unpaidBreakMinutes: identifier, plannedCenter: center.nullish(),
    section: section.nullish(),
}).strict()
export const rosterPeople = z.array(z.object({
    employeeId, name: z.string(),
    cells: z.array(z.object({
        date, draft: value.nullish(), published: value.nullish(),
        constraint: z.enum(['HOLIDAY', 'ABSENCE', 'NOT_EMPLOYED', 'VOLUNTARY']).nullish(),
    }).strict()).length(7),
}).strict()).max(100)
export const rosterShifts = z.array(z.object({ id: shiftId, name: z.string(), start: localTime, end: localTime }).strict())
export const rosterPending = z.array(z.object({
    employeeId, name: z.string(), dates: z.array(date).max(7),
}).strict()).max(100)

export const rosterWeek = z.object({
    monday, zone, draftRevision: identifier, publishedRevision: identifier.min(1).nullish(),
    copyFromMonday: monday.nullish(), canEdit: z.boolean(), nextAfterEmployeeId: employeeId.nullish(),
    people: rosterPeople, shifts: rosterShifts, centers: z.array(center.extend({ name: z.string() })),
}).strict()

export const rosterReview = z.object({
    requestId, action, monday, draftRevision: identifier, publishedRevision: identifier.min(1).nullish(),
    digest: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: instant.nullish(),
    changes: z.array(subject.extend({ before: value.nullish(), after: value }).strict()).max(500),
    blockers: z.array(subject.extend({ code: z.string().min(1).max(80) }).strict()).max(500),
}).strict()

export const rosterEnvelope = z.object({
    schemaVersion: z.literal(1),
    identity: z.object({
        companyId: employeeId, cif: z.string(), userName: z.string(), apiBaseUrl: z.string().url(),
    }).strict(),
    intent: rosterIntent,
    review: rosterReview.extend({ proof: z.string().min(1).max(16384) }),
}).strict()

export const rosterReceipt = z.discriminatedUnion('outcome', [
    z.object({
        outcome: z.literal('CONFIRMED'), requestId, monday, action,
        draftRevision: identifier, publishedRevision: identifier.min(1).nullish(),
    }).strict(),
    z.object({
        outcome: z.literal('NOT_OBSERVED'), requestId, monday, action: z.null().optional(),
        draftRevision: z.null().optional(), publishedRevision: z.null().optional(),
    }).strict(),
])

export const pdfScope = z.object({ week: monday, revision: identifier.min(1), employeeIds: employeeIds.optional() }).strict()
export const pdfMetadata = z.object({
    monday, revision: identifier.min(1), filename: z.string(), bytes: identifier.min(1),
}).strict()
