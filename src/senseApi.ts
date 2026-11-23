import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import type { Logging } from 'homebridge';
import WebSocket from 'ws';

import { PLUGIN_VERSION } from './settings.js';
import { generateTotp } from './totp.js';

const API_URL = 'https://api.sense.com/apiservice/api/v1/';
const WS_URL = 'wss://clientrt.sense.com/monitors/';
const REQUEST_TIMEOUT_MS = 30_000;
const WS_RECONNECT_BASE_MS = 30_000;
const WS_RECONNECT_MAX_MS = 300_000;
const WS_HEARTBEAT_INTERVAL_MS = 30_000;
const WS_STALE_MS = 60_000;
const DATA_EMIT_THROTTLE_MS = 5_000;
const AUTH_CACHE_FILE = 'sense_auth.json';
const DEVICE_MIN_WATTS = 5;

export interface ActiveDevice {
    name: string;
    power: number;
}

export interface RealtimeData {
    power: number;
    solarPower: number;
    voltage: number[];
    frequency: number;
    devices: ActiveDevice[];
}

export interface TrendData {
    dailyUsageKwh: number;
    dailyProductionKwh: number;
}

export interface SenseApiOptions {
    log: Logging;
    username: string;
    password: string;
    monitorId?: string | null;
    mfaEnabled?: boolean;
    mfaSecret?: string | null;
    storagePath?: string | null;
}

interface SenseMonitor {
    id: string;
}

interface AuthResponse {
    authorized?: boolean;
    access_token?: string;
    refresh_token?: string;
    user_id?: number;
    account_id?: number;
    monitors?: SenseMonitor[];
    status?: string;
    mfa_token?: string;
    error_reason?: string;
}

interface AuthCache {
    access_token?: string;
    refresh_token?: string;
    user_id?: number;
    account_id?: number;
    monitor_id?: string | number | null;
    monitors?: SenseMonitor[];
    issued_at?: number;
}

interface TrendsResponse {
    consumption?: { total?: number };
    production?: { total?: number };
}

interface RealtimePayload {
    w?: number;
    d_w?: number;
    solar_w?: number;
    voltage?: number[];
    hz?: number;
    devices?: { name?: string; w?: number }[];
}

export class SenseApi extends EventEmitter {
    public monitorId: string | null;
    public realtime: RealtimeData = { power: 0, solarPower: 0, voltage: [], frequency: 0, devices: [] };

    private readonly log: Logging;
    private readonly username: string;
    private readonly password: string;
    private readonly mfaEnabled: boolean;
    private readonly mfaSecret: string | null;
    private readonly storagePath: string | null;

    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private userId: number | null = null;
    private accountId: number | null = null;
    private monitors: SenseMonitor[] = [];
    private issuedAt = 0;

    private ws: WebSocket | null = null;
    private wsReconnectTimer: NodeJS.Timeout | null = null;
    private wsHeartbeatTimer: NodeJS.Timeout | null = null;
    private wsStaleTimer: NodeJS.Timeout | null = null;
    private lastDataEmit = 0;
    private destroyed = false;

    constructor(options: SenseApiOptions) {
        super();
        this.log = options.log;
        this.username = options.username;
        this.password = options.password;
        this.monitorId = options.monitorId ?? null;
        this.mfaEnabled = options.mfaEnabled ?? false;
        this.mfaSecret = options.mfaSecret ?? null;
        this.storagePath = options.storagePath ?? null;
        this.loadAuthCache();
    }

    get isAuthenticated(): boolean {
        return !!this.accessToken && Date.now() - this.issuedAt < 3_600_000;
    }

    async authenticate(): Promise<void> {
        this.log.info('Authenticating with Sense...');
        const form = new URLSearchParams({
            email: this.username,
            password: this.password,
        });
        const { status, body } = await this.fetchJson('authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        });

        if (status === 401 && body.status === 'mfa_required' && body.mfa_token) {
            if (!this.mfaEnabled || !this.mfaSecret) {
                throw new Error('MFA required but mfaEnabled/mfaSecret not configured');
            }
            const totp = generateTotp(this.mfaSecret);
            const mfaForm = new URLSearchParams({
                mfa_token: body.mfa_token,
                totp,
            });
            const mfaRes = await this.fetchJson('authenticate/mfa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: mfaForm.toString(),
            });
            if (mfaRes.status !== 200 || !mfaRes.body.access_token) {
                throw new Error(`MFA failed: ${mfaRes.body.error_reason || mfaRes.status}`);
            }
            this.applyAuth(mfaRes.body);
        } else if (status === 200 && body.access_token) {
            this.applyAuth(body);
        } else {
            throw new Error(`Auth failed (${status}): ${body.error_reason || JSON.stringify(body)}`);
        }

        this.emit('authenticated');
        this.saveAuthCache();
    }

    private applyAuth(body: AuthResponse): void {
        this.accessToken = body.access_token ?? null;
        this.refreshToken = body.refresh_token ?? null;
        this.userId = body.user_id ?? null;
        this.accountId = body.account_id ?? null;
        this.monitors = body.monitors ?? [];
        this.issuedAt = Date.now();
        if (!this.monitorId && this.monitors.length > 0) {
            this.monitorId = this.monitors[0].id;
        }
    }

    async validateSession(): Promise<void> {
        if (!this.isAuthenticated) {
            await this.authenticate();
        }
        // cheap probe
        await this.fetchJson(`app/monitors/${this.monitorId}/status`);
    }

    openStream(): void {
        if (this.destroyed || !this.accessToken || !this.monitorId) {
            this.log.warn('Cannot open Sense realtime stream: not authenticated yet');
            return;
        }
        this.closeStream();
        const url = `${WS_URL}${this.monitorId}/realtimefeed`;
        this.ws = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                'Sense-Client-Version': '1.18.0',
                'X-Sense-Protocol': '3',
            },
        });

        this.ws.on('open', () => {
            this.log.info('Sense realtime WebSocket connected');
            this.startHeartbeat();
        });

        this.ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(raw.toString()) as RealtimePayload;
                this.handleRealtime(payload);
            } catch (err) {
                this.log.debug('Bad realtime payload:', err);
            }
        });

        this.ws.on('pong', () => {
            // heartbeat ok
        });

        this.ws.on('close', (code: number) => {
            this.log.warn(`Sense WebSocket closed (${code}), scheduling reconnect`);
            this.scheduleReconnect();
        });

        this.ws.on('error', (error: Error) => {
            this.log.error('Sense WebSocket error:', error.message);
        });
    }

    private handleRealtime(payload: RealtimePayload): void {
        const power = payload.w ?? payload.d_w ?? 0;
        this.realtime = {
            power,
            solarPower: payload.solar_w ?? 0,
            voltage: payload.voltage ?? [],
            frequency: payload.hz ?? 0,
            devices: (payload.devices ?? [])
                .filter(d => (d.w ?? 0) >= DEVICE_MIN_WATTS)
                .map(d => ({ name: d.name || 'Device', power: d.w ?? 0 })),
        };

        const now = Date.now();
        if (now - this.lastDataEmit >= DATA_EMIT_THROTTLE_MS) {
            this.lastDataEmit = now;
            this.emit('realtime', this.realtime);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.wsHeartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, WS_HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer);
        this.wsHeartbeatTimer = null;
    }

    private scheduleReconnect(): void {
        if (this.destroyed || this.wsReconnectTimer) return;
        const delay = Math.min(WS_RECONNECT_BASE_MS * 2, WS_RECONNECT_MAX_MS);
        this.wsReconnectTimer = setTimeout(() => {
            this.wsReconnectTimer = null;
            void this.validateSession().then(() => this.openStream()).catch(err => {
                this.log.error('Reconnect failed:', err);
                this.scheduleReconnect();
            });
        }, delay);
    }

    private closeStream(): void {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
    }

    destroy(): void {
        this.destroyed = true;
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.closeStream();
        this.removeAllListeners();
    }

    private async fetchJson(endpoint: string, init: RequestInit = {}): Promise<{ status: number; body: AuthResponse & Record<string, any> }> {
        const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': `homebridge-sense-matter/${PLUGIN_VERSION}`,
            ...(init.headers as Record<string, string> || {}),
        };
        if (this.accessToken && !endpoint.includes('authenticate')) {
            headers.Authorization = `Bearer ${this.accessToken}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, { ...init, headers, signal: controller.signal });
            const body = await res.json().catch(() => ({})) as AuthResponse & Record<string, any>;
            return { status: res.status, body };
        } finally {
            clearTimeout(timeout);
        }
    }

    private loadAuthCache(): void {
        if (!this.storagePath) return;
        try {
            const raw = fs.readFileSync(path.join(this.storagePath, AUTH_CACHE_FILE), 'utf8');
            const cache = JSON.parse(raw) as AuthCache;
            this.accessToken = cache.access_token ?? null;
            this.refreshToken = cache.refresh_token ?? null;
            this.userId = cache.user_id ?? null;
            this.accountId = cache.account_id ?? null;
            this.monitorId = this.monitorId ?? (cache.monitor_id != null ? String(cache.monitor_id) : null);
            this.monitors = cache.monitors ?? [];
            this.issuedAt = cache.issued_at ?? 0;
        } catch {
            // no cache
        }
    }

    private saveAuthCache(): void {
        if (!this.storagePath) return;
        const cache: AuthCache = {
            access_token: this.accessToken ?? undefined,
            refresh_token: this.refreshToken ?? undefined,
            user_id: this.userId ?? undefined,
            account_id: this.accountId ?? undefined,
            monitor_id: this.monitorId,
            monitors: this.monitors,
            issued_at: this.issuedAt,
        };
        try {
            fs.writeFileSync(path.join(this.storagePath, AUTH_CACHE_FILE), JSON.stringify(cache, null, 2));
        } catch (err) {
            this.log.warn('Failed to save auth cache:', err);
        }
    }
}
