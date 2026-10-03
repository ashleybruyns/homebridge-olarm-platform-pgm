import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { OlarmPlatform } from '../platform.js';
import type { OlarmAccessoryContext, DeviceState } from '../types.js';

/**
 * OlarmSecuritySystem
 * Handles the main Security System accessory
 * Translates HomeKit actions into commands for the OlarmController and
 * updates its state based on data received from the controller
 */
export class OlarmSecuritySystem {
  private service: Service;

  constructor(
    private readonly platform: OlarmPlatform,
    public readonly accessory: PlatformAccessory<OlarmAccessoryContext>,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'Olarm')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, 'Olarm Security Panel')
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, this.accessory.context.deviceId)
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, this.accessory.context.firmware);

    // Get or create the SecuritySystem service
    this.service = this.accessory.getService(this.platform.api.hap.Service.SecuritySystem) ||
      this.accessory.addService(this.platform.api.hap.Service.SecuritySystem, this.accessory.displayName);

    // Add the StatusFault characteristic for online/offline status
    if (!this.service.testCharacteristic(this.platform.api.hap.Characteristic.StatusFault)) {
      this.service.addCharacteristic(this.platform.api.hap.Characteristic.StatusFault);
    }

    // Set up the event handler for when a user interacts with the security system
    this.service.getCharacteristic(this.platform.api.hap.Characteristic.SecuritySystemTargetState)
      .onSet(this.handleTargetStateSet.bind(this));
  }

  /**
   * Handle requests to set the target state (arm/disarm)
   */
  async handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.info(`Home app requested to set alarm state to: ${value}`);

    const commandMap: Record<number, string> = {
      [this.platform.api.hap.Characteristic.SecuritySystemTargetState.STAY_ARM]: 'stay',
      [this.platform.api.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM]: 'arm',
      [this.platform.api.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM]: 'sleep',
      [this.platform.api.hap.Characteristic.SecuritySystemTargetState.DISARM]: 'disarm',
    };

    const command = commandMap[value as number];

    if (command) {
      await this.platform.controller.sendCommand(command);
    }
  }

  /**
   * Update the state of this accessory in HomeKit
   */
  updateState(deviceState: DeviceState, deviceStatus: string | undefined): void {
    const areaState = deviceState.areas[0] || 'disarm';
    
    // Area states as reported by the Olarm public API
    const stateMap: Record<string, number> = {
      'disarm': 3,
      'notready': 3,
      'countdown': 3,
      'arm': 1,
      'stay': 0,
      'stayarm1': 0,
      'stayarm2': 0,
      'stayarm3': 0,
      'stayarm4': 0,
      'sleep': 2,
      'alarm': 4,
      'emergency': 4,
      'fire': 4,
      'medical': 4,
    };

    // During the entry delay the area is still armed; keep the current state
    if (areaState === 'entrydelay') {
      return;
    }

    const homekitState = stateMap[areaState] ?? 3;

    // Get current state
    const oldState = this.service.getCharacteristic(this.platform.api.hap.Characteristic.SecuritySystemCurrentState).value;

    // Only log if state changed
    if (oldState !== homekitState) {
      const stateNames: Record<number, string> = {
        0: 'Stay Armed',
        1: 'Away Armed',
        2: 'Night Armed',
        3: 'Disarmed',
        4: 'Alarm Triggered',
      };
      this.platform.log.info(`Security System: ${stateNames[homekitState] || areaState}`);
    }

    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.SecuritySystemCurrentState, homekitState);
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.SecuritySystemTargetState, homekitState);
    this.service.updateCharacteristic(
      this.platform.api.hap.Characteristic.StatusFault,
      deviceStatus === 'offline' ? 1 : 0,
    );
  }
}