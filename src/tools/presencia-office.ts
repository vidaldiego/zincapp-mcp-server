import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { z } from 'zod'
import type { OfficeRosterConfig } from './roster-office.js'

export const requestId = z.string().uuid().transform(value => value.toLowerCase())
export const employeeId = z.number().int().min(1).max(2147483647)
const date = z.string().date()
const timestamp = z.string().datetime({ offset: true })
const revision = z.string().min(1).max(128)
const action = z.enum(['ENTRY', 'START_BREAK', 'END_BREAK', 'EXIT'])
const centerFields = { clientId: employeeId, centerId: employeeId }
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

const configuration = z.object({
    employeeId, revision,
    periods: z.array(participation.extend({ effectiveUntil: date.nullish() }).strict()),
}).strict()
const reviewFields = z.object({
    requestId, employeeId, workDate: date, revision,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    proof: z.string().min(1).max(16384),
    expiresAt: timestamp,
})
const review = z.discriminatedUnion('kind', [
    reviewFields.extend({ kind: z.literal('CONFIGURE'), proposal: configurationChange }).strict(),
    reviewFields.extend({ kind: z.literal('ASSISTED_PUNCH'), proposal: assistedPunch }).strict(),
])
const proposalEnvelope = z.object({
    schemaVersion: z.literal(1),
    identity: z.object({
        companyId: employeeId, cif: z.string(), userName: z.string(), apiBaseUrl: z.string().url(),
    }).strict(),
    review,
}).strict()
const receipt = z.object({
    requestId,
    outcome: z.enum(['NOT_OBSERVED', 'CONFIRMED', 'REJECTED', 'CANCELLED']),
    kind: z.enum(['CONFIGURE', 'ASSISTED_PUNCH', 'OWN_PUNCH']).nullish(),
    code: z.string().nullish(),
    employeeId: employeeId.nullish(),
    workDate: date.nullish(),
    punch: z.object({ action, at: timestamp }).strict().nullish(),
}).strict()

const execute = promisify(execFile)
const maxBytes = 4 << 20
export class PresenciaToolError extends Error {}

function shellQuote(value: string) {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

function ownedByProcess(info: { uid: number }) {
    return !process.getuid || info.uid === process.getuid()
}

export class OfficePresencia {
    constructor(private readonly config: OfficeRosterConfig) {}

    private async command(group: 'configuration' | 'assist' | 'operation', verb: 'get' | 'preview', args: string[]) {
        const env = { ...process.env }
        delete env.ZINCAPP_AGENT_TOKEN
        try {
            const { stdout } = await execute(this.config.executable, [
                `--profile=${this.config.profile}`, '--json', 'attendance', 'presencia', group, verb, ...args,
            ], { env, timeout: 45_000, maxBuffer: maxBytes })
            return JSON.parse(stdout) as unknown
        } catch (error) {
            const stderr = (error as { stderr?: unknown }).stderr
            const status = typeof stderr === 'string' && stderr.match(/\bHTTP (4[0-9]{2}|5[0-9]{2})\b/)
            if (status) throw new PresenciaToolError(`La CLI de Presencia devolvió HTTP ${status[1]}.`)
            throw new PresenciaToolError('La CLI de oficina no completó la consulta de Presencia.')
        }
    }

    async getConfiguration(id: number) {
        const employee = employeeId.parse(id)
        const result = configuration.parse(await this.command('configuration', 'get', [`--employee-id=${employee}`]))
        if (result.employeeId !== employee) throw new PresenciaToolError('La configuración corresponde a otra persona.')
        return result
    }

    previewConfiguration(id: number, change: z.input<typeof configurationChange>) {
        const employee = employeeId.parse(id)
        return this.preview('configuration', employee, configurationChange.parse(change), [`--employee-id=${employee}`])
    }

    previewAssist(punch: z.input<typeof assistedPunch>) {
        const input = assistedPunch.parse(punch)
        return this.preview('assist', input.employeeId, input, [])
    }

    private async preview(
        group: 'configuration' | 'assist',
        employee: number,
        input: z.output<typeof configurationChange> | z.output<typeof assistedPunch>,
        args: string[],
    ) {
        await mkdir(this.config.stateDir, { mode: 0o700, recursive: true })
        const state = await lstat(this.config.stateDir)
        if (!state.isDirectory() || !ownedByProcess(state) || (state.mode & 0o077) !== 0) {
            throw new PresenciaToolError('El directorio de propuestas de Presencia debe ser privado y pertenecer al usuario del MCP.')
        }

        const directory = await mkdtemp(join(this.config.stateDir, 'review-'))
        const inputPath = join(directory, 'input.json')
        const proposalPath = join(directory, 'proposal.json')
        try {
            await writeFile(inputPath, JSON.stringify(input), { mode: 0o600, flag: 'wx' })
            const reviewed = review.parse(await this.command(group, 'preview', [
                ...args, `--input=${inputPath}`, `--output=${proposalPath}`,
            ]))
            const expectedKind = group === 'configuration' ? 'CONFIGURE' : 'ASSISTED_PUNCH'
            if (reviewed.kind !== expectedKind || reviewed.requestId !== input.requestId ||
                reviewed.proposal.requestId !== input.requestId || reviewed.employeeId !== employee ||
                (reviewed.kind === 'ASSISTED_PUNCH' && reviewed.proposal.employeeId !== employee)) {
                throw new PresenciaToolError('La revisión de Presencia no coincide con la operación solicitada.')
            }
            const info = await lstat(proposalPath)
            if (!info.isFile() || !ownedByProcess(info) || (info.mode & 0o777) !== 0o600 || info.size > maxBytes) {
                throw new PresenciaToolError('La CLI no guardó una propuesta privada de Presencia.')
            }
            const saved = proposalEnvelope.parse(JSON.parse(await readFile(proposalPath, 'utf8')))
            if (!isDeepStrictEqual(saved.review, reviewed)) {
                throw new PresenciaToolError('La propuesta guardada difiere de la revisión de Presencia.')
            }
            await unlink(inputPath)
            const { proof, ...visibleReview } = reviewed
            const { companyId, cif, userName } = saved.identity
            const terminalCommand = [
                shellQuote(this.config.executable), `--profile=${shellQuote(this.config.profile)}`,
                'attendance', 'presencia', group, 'apply', `--proposal=${shellQuote(proposalPath)}`,
            ].join(' ')
            return { review: visibleReview, identity: { companyId, cif, userName }, proposalPath, terminalCommand }
        } catch (error) {
            await rm(directory, { recursive: true })
            throw error
        }
    }

    async recover(id: string) {
        const uuid = requestId.parse(id)
        const result = receipt.parse(await this.command('operation', 'get', [`--request-id=${uuid}`]))
        if (result.requestId !== uuid) throw new PresenciaToolError('El recibo corresponde a otra operación de Presencia.')
        return result
    }
}
