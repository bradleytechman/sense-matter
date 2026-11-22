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

import { SenseApi, type RealtimeData } from './senseApi.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface SenseConfig extends PlatformConfig {
  username: string;
  password: string;
  monitorId?: string;
  mfaEnabled?: boolean;
  mfaSecret?: string;
  pollingInterval?: number;
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

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!this.api.matter) {
      this.log.warn('Matter is not enabled. Enable Matter in your Homebridge bridge settings for energy data to appear in the Home app.');
    }

    this.api.on('didFinishLaunching', () => {
      void this.init();
    });

    this.api.on('shutdown', () => {
      this.senseApi?.destroy();
    });
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
      mfaEnabled: cfg.mfaEnabled,
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
    this.senseApi.openStream();

    this.senseApi.on('realtime', (data: RealtimeData) => {
      this.updateMatterState(data);
    });

    // Fallback polling
    const interval = (cfg.pollingInterval ?? 30) * 1000;
    setInterval(() => {
      if (this.senseApi?.realtime) {
        this.updateMatterState(this.senseApi.realtime);
      }
    }, interval);
  }

  private async registerMatterAccessory(): Promise<void> {
    if (!this.api.matter) return;

    const uuid = this.api.hap.uuid.generate('sense-matter-whole-home');
    this.matterAccessoryUuid = uuid;

    const accessory: MatterAccessory = {
      UUID: uuid,
      displayName: 'Sense Energy',
      deviceType: this.api.matter.deviceTypes.OnOffOutlet,
      manufacturer: 'Sense',
      model: 'Energy Monitor',
      serialNumber: 'sense-whole-home',
      context: {},
      clusters: {
        onOff: { onOff: true },
        electricalPowerMeasurement: {
          activePower: 0,       // mW
          voltage: 120_000,     // mV
          activeCurrent: 0,     // mA
        },
        electricalEnergyMeasurement: {
          cumulativeEnergyImported: { energy: 0 }, // mWh
        },
      },
    };

    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Registered Sense as Matter energy device (OnOffOutlet + power/energy clusters)');
    } catch (err) {
      this.log.error('Failed to register Matter accessory:', err);
    }
  }

  private updateMatterState(data: RealtimeData): void {
    if (!this.matterAccessoryUuid || !this.api.matter) return;

    const now = Date.now();
    const deltaHours = (now - this.lastPowerUpdate) / 3_600_000;
    this.cumulativeEnergyWh += (data.power * deltaHours);
    this.lastPowerUpdate = now;

    const powerMw = Math.round(data.power * 1000);
    const voltageMv = data.voltage?.[0] ? Math.round(data.voltage[0] * 1000) : 120_000;
    const currentMa = voltageMv > 0 ? Math.round((powerMw / voltageMv) * 1000) : 0;
    const energyMwh = Math.round(this.cumulativeEnergyWh * 1000);

    void this.api.matter.updateAccessoryState(this.matterAccessoryUuid, 'electricalPowerMeasurement', {
      activePower: powerMw,
      voltage: voltageMv,
      activeCurrent: currentMa,
    });

    void this.api.matter.updateAccessoryState(this.matterAccessoryUuid, 'electricalEnergyMeasurement', {
      cumulativeEnergyImported: { energy: energyMwh },
    });

    this.log.debug(`Updated Matter: ${data.power} W, ${this.cumulativeEnergyWh.toFixed(2)} Wh`);
  }
}
