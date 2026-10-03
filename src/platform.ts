import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { OlarmController } from './services/controller.js';
import { OlarmSecuritySystem } from './accessories/securitySystem.js';
import { OlarmZoneSensor } from './accessories/zoneSensor.js';
import { OlarmAutomationSwitch } from './accessories/automationSwitch.js';
import { OlarmGate } from './accessories/gateAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { OlarmPlatformConfig, OlarmPlatformAccessory, DeviceData } from './types.js';

export class OlarmPlatform implements DynamicPlatformPlugin {
  public readonly accessories: Map<string, OlarmPlatformAccessory> = new Map();
  public readonly accessoryHandlers: Map<string, OlarmSecuritySystem | OlarmZoneSensor | OlarmAutomationSwitch | OlarmGate> = new Map();
  public controller!: OlarmController;
  private apiKey = '';
  private discoveryRetryTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig & OlarmPlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Olarm Platform is starting...');

    const apiKey = this.config.apiKey || this.config.fallbackAuth?.apiKey;
    if (!apiKey) {
      this.log.error('FATAL: "apiKey" is required. Generate one in the Olarm user portal under API access.');
      return;
    }
    if (!this.config.apiKey) {
      this.log.warn('"fallbackAuth.apiKey" is deprecated - move the API key to "apiKey".');
    }
    if (this.config.primaryAuth) {
      this.log.warn('"primaryAuth" (email/password) is no longer used and can be removed from the config.');
    }
    if (!this.config.deviceId) {
      this.log.error('FATAL: "deviceId" is required. Available devices will be listed once it is set to any value.');
      return;
    }
    this.apiKey = apiKey;

    // Graceful shutdown
    this.api.on('shutdown', () => {
      this.log.info('Olarm: Shutting down gracefully...');
      this.controller?.stop();
      if (this.discoveryRetryTimer) {
        clearTimeout(this.discoveryRetryTimer);
      }
      this.log.info('Olarm: Shutdown complete');
    });

    this.api.on('didFinishLaunching', async () => {
      this.log.info('Homebridge has finished launching. Initializing Olarm controller...');
      await this.initializeController();
    });
  }

  /**
   * Restore cached accessories from disk
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Restoring accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory as OlarmPlatformAccessory);
  }

  /**
   * Initialize the controller, discover accessories, then start real-time updates
   */
  async initializeController(): Promise<void> {
    this.controller = new OlarmController(this, this.apiKey);

    this.controller.on('stateUpdate', (deviceData) => {
      this.updateAllAccessoryStates(deviceData);
    });

    const discovered = await this.discoverDevices();
    await this.controller.start();
    if (!discovered) {
      this.retryDiscovery();
    }
  }

  /**
   * Keep retrying accessory setup until the initial device state can be fetched
   */
  private retryDiscovery(): void {
    this.log.warn('Retrying accessory setup in 60s...');
    this.discoveryRetryTimer = setTimeout(async () => {
      if (!(await this.discoverDevices())) {
        this.retryDiscovery();
      }
    }, 60000);
  }

  /**
   * Discover and register all accessories
   */
  async discoverDevices(): Promise<boolean> {
    await this.controller.refreshState();
    const deviceDetails = this.controller.deviceData;

    if (!deviceDetails) {
      this.log.error('Could not fetch initial device data. Aborting accessory setup.');
      return false;
    }

    const currentAccessoryUuids = new Set<string>();

    // Register main security system
    const securityUuid = this.api.hap.uuid.generate(this.config.deviceId);
    this.getAccessoryHandler(
      OlarmSecuritySystem,
      deviceDetails,
      securityUuid,
      this.config.deviceName || 'Olarm Security',
    );
    currentAccessoryUuids.add(securityUuid);

    // Register zone sensors
    const includedZones = this.config.includedZones;
    this.log.debug(`Panel deviceStatus: ${deviceDetails.deviceStatus ?? '(not provided)'}`);
    this.log.debug(`Panel PGM settings (pgmControl): ${JSON.stringify(deviceDetails.deviceProfile?.pgmControl ?? null)}`);
    this.log.info(`Device profile exists: ${!!deviceDetails.deviceProfile}`);
    this.log.info(`Zone labels exist: ${!!deviceDetails.deviceProfile?.zonesLabels}`);
    this.log.info(`Zone labels count: ${deviceDetails.deviceProfile?.zonesLabels?.length || 0}`);

    if (deviceDetails.deviceProfile && deviceDetails.deviceProfile.zonesLabels) {
      deviceDetails.deviceProfile.zonesLabels.forEach((zoneName, index) => {
        const zoneNum = index + 1;
        if (includedZones && !includedZones.includes(zoneNum)) {
          return;
        }
        if (!zoneName || zoneName.trim() === '') {
          return;
        }

        const zoneUuid = this.api.hap.uuid.generate(`${this.config.deviceId}-zone-${zoneNum}`);
        const handler = this.getAccessoryHandler(OlarmZoneSensor, deviceDetails, zoneUuid, zoneName);
        handler.accessory.context.zoneNum = zoneNum;
        currentAccessoryUuids.add(zoneUuid);
      });
    }

    // Register automation switches
    if (this.config.automations && Array.isArray(this.config.automations)) {
      this.log.info(`Found ${this.config.automations.length} automation(s) to set up`);
      this.config.automations.forEach((automation, index) => {
        this.log.info(`Setting up automation: ${automation.name}`);
        const autoUuid = this.api.hap.uuid.generate(`${this.config.deviceId}-automation-${automation.id || index}`);
        const handler = this.getAccessoryHandler(OlarmAutomationSwitch, deviceDetails, autoUuid, automation.name);
        
        if (handler instanceof OlarmAutomationSwitch) {
          handler.config = automation;
          this.log.info(`Config set for ${automation.name}`);
        }
        currentAccessoryUuids.add(autoUuid);
      });
      this.log.info('All automations set up');
    }

    // Register gate accessories
    if (this.config.gates && Array.isArray(this.config.gates)) {
      this.log.info(`Found ${this.config.gates.length} gate(s) to set up`);
      this.config.gates.forEach((gate) => {
        if (!gate.name || !Number.isInteger(gate.zone) || gate.zone < 1 || !Number.isInteger(gate.pgm) || gate.pgm < 1) {
          this.log.error(`Skipping gate "${gate.name ?? '(unnamed)'}": "name", "zone" and "pgm" are required`);
          return;
        }
        this.log.info(`Setting up gate: ${gate.name}`);
        // Key on zone+PGM when no id is given, so reordering the config never
        // swaps which physical gate an existing HomeKit accessory controls
        const gateUuid = this.api.hap.uuid.generate(`${this.config.deviceId}-gate-${gate.id || `z${gate.zone}-p${gate.pgm}`}`);
        const handler = this.getAccessoryHandler(OlarmGate, deviceDetails, gateUuid, gate.name);

        if (handler instanceof OlarmGate) {
          handler.configure(gate);
        }
        const pgmProblem = this.controller.pgmPulseProblem(gate.pgm);
        if (pgmProblem) {
          this.log.error(`Gate "${gate.name}" will refuse to operate: ${pgmProblem}. Check the PGM number and its settings in the Olarm app.`);
        }
        currentAccessoryUuids.add(gateUuid);
      });
    }

    // Remove stale accessories
    for (const [uuid, accessory] of this.accessories.entries()) {
      if (!currentAccessoryUuids.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.accessoryHandlers.delete(uuid);
      }
    }

    // The initial refreshState() update fired before these handlers existed
    this.updateAllAccessoryStates(deviceDetails);
    return true;
  }

  /**
   * Get or create an accessory handler
   */
  getAccessoryHandler(
    HandlerClass: typeof OlarmSecuritySystem | typeof OlarmZoneSensor | typeof OlarmAutomationSwitch | typeof OlarmGate,
    deviceDetails: DeviceData,
    uuid: string,
    displayName: string,
  ): OlarmSecuritySystem | OlarmZoneSensor | OlarmAutomationSwitch | OlarmGate {
    let accessory = this.accessories.get(uuid);
    
    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    accessory.context.deviceId = this.config.deviceId;
    accessory.context.firmware = deviceDetails.deviceFirmware || '0.0.0';

    let handler = this.accessoryHandlers.get(uuid);
    if (!handler) {
      handler = new HandlerClass(this, accessory);
      this.accessoryHandlers.set(uuid, handler);
    }
    
    return handler;
  }

  /**
   * Update all accessories with fresh state data
   */
  updateAllAccessoryStates(deviceData: DeviceData): void {
    if (!deviceData) {
      return;
    }

    for (const handler of this.accessoryHandlers.values()) {
      if (handler instanceof OlarmSecuritySystem) {
        handler.updateState(deviceData.deviceState, deviceData.deviceStatus);
      }
      if (handler instanceof OlarmZoneSensor) {
        const zoneNum = handler.accessory.context.zoneNum;
        if (zoneNum) {
          const zoneState = deviceData.deviceState.zones[zoneNum - 1];
          handler.updateState(zoneState);
        }
      }
      if (handler instanceof OlarmGate) {
        const zoneNum = handler.accessory.context.zoneNum;
        if (zoneNum) {
          handler.updateState(deviceData.deviceState?.zones?.[zoneNum - 1], deviceData.deviceStatus);
        }
      }
    }
  }
}