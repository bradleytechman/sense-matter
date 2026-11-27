import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  MatterAccessory,
} from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { SenseApi, type RealtimeData } from './senseApi.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface SenseConfig extends PlatformConfig {
  username: string;
  password: string;
  monitorId?: string;
  mfaType?: 'Disabled' | 'TOTP';
  mfaSecret?: string;
  pollingInterval?: number;
  deviceType?: 'sensor' | 'outlet';
}

export class SenseMatterPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private matterAccessories = new Map<string, MatterAccessory>();
  private senseApi?: SenseApi;
  private matterAccessoryUuid?: string;
  private cumulativeEnergyWh = 0;
  private lastPowerUpdate = Date.now();
  private lastEnergyPush = 0;
  private lastPowerLog = 0;
  private pollTimer?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setInterval>;
  private energyFile: string;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.energyFile = path.join(this.api.user.storagePath(), 'sense-matter-energy.json');

    if (!this.api.matter) {
      this.log.warn('Matter is not enabled. Enable Matter in your Homebridge bridge settings for energy data to appear in the Home app.');
    }

    this.loadEnergy();

    this.api.on('didFinishLaunching', () => {
      void this.init();
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.saveTimer) clearInterval(this.saveTimer);
      this.saveEnergy();
      this.senseApi?.destroy();
    });
  }

  private loadEnergy(): void {
    try {
      if (fs.existsSync(this.energyFile)) {
        const data = JSON.parse(fs.readFileSync(this.energyFile, 'utf8'));
        this.cumulativeEnergyWh = data.cumulativeEnergyWh || 0;
        this.log.info(`Restored cumulative energy: ${this.cumulativeEnergyWh.toFixed(2)} Wh`);
      }
    } catch (e) {
      this.log.debug('No prior energy data or failed to load');
    }
  }

  private saveEnergy(): void {
    try {
      fs.writeFileSync(this.energyFile, JSON.stringify({ cumulativeEnergyWh: this.cumulativeEnergyWh }));
    } catch (e) {
      this.log.error('Failed to save energy data:', e);
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.log.debug(`Restored cached Matter accessory ${accessory.displayName}`);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    const cfg = this.config as SenseConfig;
    if (!cfg.username || !cfg.password) {
      this.log.error('Missing Sense username or password');
      return;
    }

    this.senseApi = new SenseApi({
      log: this.log,
      username: cfg.username,
      password: cfg.password,
      monitorId: cfg.monitorId,
      mfaEnabled: cfg.mfaType === 'TOTP',
      mfaSecret: cfg.mfaSecret,
      storagePath: this.api.user.storagePath(),
    });

    try {
      if (!this.senseApi.isAuthenticated) {
        await this.senseApi.authenticate();
      }
      await this.senseApi.validateSession();
    } catch (err) {
      this.log.error('Sense authentication failed:', err);
      return;
    }

    await this.registerMatterAccessory();

    this.senseApi.on('realtime', (data: RealtimeData) => {
      this.updateMatterState(data);
    });

    // The initial realtime object is { power: 0 } until a frame arrives.
    // Publishing that is what pinned Home at 0 W.
    this.senseApi.openStream();

    const interval = Math.max(10, cfg.pollingInterval ?? 30) * 1000;
    this.pollTimer = setInterval(() => {
      void this.pollIfStreamDown();
    }, interval);

    this.saveTimer = setInterval(() => this.saveEnergy(), 5 * 60 * 1000);
  }

  private async pollIfStreamDown(): Promise<void> {
    const api = this.senseApi;
    if (!api || api.isStreamOpen) return;
    try {
      await api.updateRealtime();
    } catch (err) {
      this.log.warn(`Sense realtime poll failed: ${(err as Error).message}`);
    }
  }

  private async registerMatterAccessory(): Promise<void> {
    if (!this.api.matter) return;

    const cfg = this.config as SenseConfig;
    const useOutlet = cfg.deviceType === 'outlet';
    const deviceType = useOutlet
      ? this.api.matter.deviceTypes.OnOffOutlet
      : this.api.matter.deviceTypes.ElectricalSensor;

    const uuid = this.api.hap.uuid.generate('sense-matter-whole-home');
    this.matterAccessoryUuid = uuid;

    const clusters: any = {
      electricalPowerMeasurement: {
        activePower: 0,
        voltage: 120_000,
        activeCurrent: 0,
      },
      electricalEnergyMeasurement: {
        cumulativeEnergyImported: { energy: Math.round(this.cumulativeEnergyWh * 1000) },
      },
    };

    if (useOutlet) {
      clusters.onOff = { onOff: true };
    }

    const accessory: MatterAccessory = {
      UUID: uuid,
      displayName: 'Sense Energy',
      deviceType,
      manufacturer: 'Sense',
      model: 'Energy Monitor',
      serialNumber: 'sense-whole-home',
      context: {},
      clusters,
    };

    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Registered Sense as Matter ${useOutlet ? 'OnOffOutlet (tile with live watts)' : 'ElectricalSensor (Energy section only)'}`);
    } catch (err) {
      this.log.error('Failed to register Matter accessory:', err);
    }
  }

  private updateMatterState(data: RealtimeData): void {
    if (!this.matterAccessoryUuid || !this.api.matter) return;
    if (!Number.isFinite(data.power)) return;

    const now = Date.now();
    // Cap the gap so a long disconnect does not dump an hour of watts into the counter.
    const deltaMs = Math.min(Math.max(0, now - this.lastPowerUpdate), 120_000);
    this.cumulativeEnergyWh += data.power * (deltaMs / 3_600_000);
    this.lastPowerUpdate = now;

    const powerMw = Math.round(data.power * 1000);
    const leg = data.voltage?.find(v => v > 50);
    const voltageMv = leg ? Math.round(leg * 1000) : 120_000;
    const currentMa = voltageMv > 0 ? Math.round((powerMw / voltageMv) * 1000) : 0;

    const uuid = this.matterAccessoryUuid;
    void this.api.matter.updateAccessoryState(uuid, 'electricalPowerMeasurement', {
      activePower: powerMw,
      voltage: voltageMv,
      activeCurrent: currentMa,
    }).catch((err: unknown) => {
      this.log.error('Matter power update failed:', err);
    });

    if (now - this.lastPowerLog > 5 * 60 * 1000) {
      this.lastPowerLog = now;
      this.log.info(`Sense power: ${Math.round(data.power)} W`);
    }

    // Throttle energy updates to ~once per 60s to avoid subscription failures
    if (now - this.lastEnergyPush > 60_000) {
      const energyMwh = Math.round(this.cumulativeEnergyWh * 1000);
      void this.api.matter.updateAccessoryState(uuid, 'electricalEnergyMeasurement', {
        cumulativeEnergyImported: { energy: energyMwh },
      }).catch((err: unknown) => {
        this.log.error('Matter energy update failed:', err);
      });
      this.lastEnergyPush = now;
      this.saveEnergy();
      this.log.debug(`Updated Matter energy: ${this.cumulativeEnergyWh.toFixed(2)} Wh`);
    }
  }
}
