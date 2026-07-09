import type { McpConfig } from './config.js'

export class ZincAppClient {
    private baseUrl: string
    private token: string
    private locale: string

    constructor(config: McpConfig) {
        this.baseUrl = config.apiBaseUrl.replace(/\/$/, '')
        this.token = config.agentToken
        this.locale = config.locale
    }

    async get<T>(path: string, params?: Record<string, string>): Promise<T> {
        const url = new URL(`${this.baseUrl}/agent/v1${path}`)
        // Auto-append locale if not English
        if (this.locale && this.locale !== 'en') {
            url.searchParams.set('locale', this.locale)
        }
        // Apply per-call param overrides
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url.searchParams.set(k, v)
            }
        }
        const res = await fetch(url.toString(), {
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

    async post<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
        const url = `${this.baseUrl}/agent/v1${path}`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                // Optional per-call headers (currently unused; kept for forward compatibility).
                ...(extraHeaders ?? {}),
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
