import type { McpConfig } from './config.js'

export class ZincAppClient {
    private baseUrl: string
    private token: string

    constructor(config: McpConfig) {
        this.baseUrl = config.apiBaseUrl.replace(/\/$/, '')
        this.token = config.agentToken
    }

    async get<T>(path: string): Promise<T> {
        const url = `${this.baseUrl}/agent/v1${path}`
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/json',
            },
        })

        if (!res.ok) {
            const body = await res.text()
            throw new Error(`API error ${res.status}: ${body}`)
        }

        return res.json() as Promise<T>
    }

    async post<T>(path: string, body?: unknown): Promise<T> {
        const url = `${this.baseUrl}/agent/v1${path}`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`API error ${res.status}: ${text}`)
        }

        return res.json() as Promise<T>
    }
}
