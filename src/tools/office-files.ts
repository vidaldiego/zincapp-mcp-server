import { lstat, mkdir, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'

function ownedByProcess(info: { uid: number }) {
    return !process.getuid || info.uid === process.getuid()
}

export function shellQuote(value: string) {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

export async function createOfficeDirectory(stateDir: string, prefix: string) {
    await mkdir(stateDir, { mode: 0o700, recursive: true })
    const info = await lstat(stateDir)
    if (!info.isDirectory() || !ownedByProcess(info) || (info.mode & 0o077) !== 0) return undefined
    return mkdtemp(join(stateDir, prefix))
}

export async function privateOfficeFileSize(path: string, maxSize: number) {
    const info = await lstat(path)
    if (!info.isFile() || !ownedByProcess(info) || (info.mode & 0o777) !== 0o600 || info.size > maxSize) {
        return undefined
    }
    return info.size
}

export async function matchesPrivateOfficeFile(path: string, maxSize: number, expectedSize: number, prefix: Buffer) {
    if (await privateOfficeFileSize(path, maxSize) !== expectedSize) return false
    const file = await open(path, 'r')
    try {
        const header = Buffer.alloc(prefix.length)
        const result = await file.read(header, 0, header.length, 0)
        return result.bytesRead === header.length && header.equals(prefix)
    } finally {
        await file.close()
    }
}
