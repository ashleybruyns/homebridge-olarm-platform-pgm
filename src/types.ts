/**
 * Type definitions for Olarm plugin
 */

import { PlatformAccessory } from 'homebridge';

/**
 * Plugin configuration from config.json
 */
export interface OlarmPlatformConfig {
  name: string;
  deviceId: string;
  deviceName?: string;
  apiKey?: string;
  /** @deprecated Older location of the API key; use `apiKey` */
  fallbackAuth?: {
    apiKey?: string;
  };
  /** @deprecated Native app login, no longer used */
  primaryAuth?: unknown;
  mqttClientIdSuffix?: string;
  includedZones?: number[];
  addBypassSwitches?: boolean;
  pollingInterval?: number;
  automations?: AutomationConfig[];
  gates?: GateConfig[];
}

/**
 * Automation configuration
 */
export interface AutomationConfig {
  id?: string;
  name: string;
  zones: number[];
  armMode: 'arm' | 'stay' | 'sleep';
}

/**
 * Gate configuration
 * Pairs a zone (reports open/closed state) with a PGM (pulsed to trigger the gate motor)
 */
export interface GateConfig {
  id?: string;
  name: string;
  zone: number;
  pgm: number;
  operationTime?: number;
}

/**
 * Response from GET /devices
 */
export interface OlarmDevicesResponse {
  userId?: string;
  data?: Array<{
    deviceId: string;
    deviceName?: string;
  }>;
}

/**
 * Device profile with zone labels
 */
export interface DeviceProfile {
  zonesLabels?: string[];
  pgmLabels?: string[];
  /**
   * Per-PGM capability flags, e.g. "101": [0] enabled, [1] open/close allowed, [2] pulse allowed
   */
  pgmControl?: string[];
  areasLabels?: string[];
}

/**
 * Device state from MQTT/API
 */
export interface DeviceState {
  areas: string[];
  zones: string[];
  pgms?: string[];
  utility?: string[];
}

/**
 * Device data from GET /devices/{deviceId}
 */
export interface DeviceData {
  deviceId?: string;
  deviceName?: string;
  deviceState: DeviceState;
  deviceStatus?: string;
  deviceProfile?: DeviceProfile;
  deviceFirmware?: string;
}

/**
 * Message on the public MQTT feed (v4/devices/{deviceId}). Messages carry
 * different parts of the device data; only the parts present are updated.
 */
export interface OlarmMqttPayload {
  deviceState?: DeviceState;
  deviceStatus?: string;
  deviceProfile?: DeviceProfile;
}

/**
 * Extended PlatformAccessory context
 */
export interface OlarmAccessoryContext {
  deviceId: string;
  firmware: string;
  zoneNum?: number;
  pgmNum?: number;
}

/**
 * Typed PlatformAccessory for Olarm
 */
export type OlarmPlatformAccessory = PlatformAccessory<OlarmAccessoryContext>;