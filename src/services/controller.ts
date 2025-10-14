import mqtt from 'mqtt';
import axios from 'axios';
import { NATIVE_MQTT_HOST, NATIVE_MQTT_PORT, NATIVE_MQTT_USERNAME, PUBLIC_API_BASE_URL } from '../settings.js';
import type { OlarmPlatform } from '../platform.js';
import type { OlarmAuth } from './auth.js';
import type { DeviceData, DeviceState, MqttPayload } from '../types.js';

export class OlarmController {
  public mqttClient: mqtt.MqttClient | null = null;
  public pollingTimer: NodeJS.Timeout | null = null;
  public stateRequestInterval: NodeJS.Timeout | null = null;
  public deviceData: DeviceData | null = null;
  private auth: OlarmAuth | null = null;
  private onStateUpdate: (deviceData: DeviceData) => void = () => { };
  private previousState: DeviceState | null = null;
  private authErrorHandled = false;

  constructor(
    private readonly platform: OlarmPlatform,
  ) { }

  /**
   * Connect to MQTT broker with native app authentication
   */
  connect(auth: OlarmAuth): void {
    this.auth = auth;
    const device = this.auth.getDevice();

    if (!device) {
      this.platform.log.error('Controller: No matching device found. Activating polling fallback.');
      this.activatePollingFallback();
      return;
    }

    const mqttOptions: mqtt.IClientOptions = {
      host: NATIVE_MQTT_HOST,
      port: NATIVE_MQTT_PORT,
      protocol: 'wss',
      username: NATIVE_MQTT_USERNAME,
      password: this.auth.getAccessToken() || undefined,
      clientId: `native-app-oauth-${device.IMEI}`,
      protocolVersion: 4,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
      keepalive: 30,
    };

    this.platform.log.info('Controller: Connecting to MQTT broker...');
    this.mqttClient = mqtt.connect(mqttOptions);

    this.mqttClient.on('connect', () => {
      this.platform.log.info('Controller: MQTT connected successfully');
      this.deactivatePollingFallback();

      const topic = `so/app/v1/${device.IMEI}`;
      this.mqttClient!.subscribe(topic, { qos: 1 }, (err) => {
        if (!err) {
          this.platform.log.info('Controller: Subscribed to device updates');
          this.startPeriodicStateRequests(device.IMEI);
        } else {
          this.platform.log.error('Controller: MQTT subscription failed:', err);
        }
      });
    });

    this.mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString()) as MqttPayload;
        this.platform.log.debug(`Controller: MQTT message received - type: ${payload.type}`);

        if (payload && payload.type === 'alarmPayload' && payload.data) {
          if (!this.deviceData) {
            this.deviceData = { deviceState: {} as DeviceState, deviceStatus: 'online', deviceProfile: {} };
          }

          // Detect and log specific state changes
          this.logStateChanges(payload.data);

          this.deviceData.deviceState = payload.data;
          this.deviceData.deviceStatus = 'online';

          this.platform.log.info('Controller: Processing MQTT state update');
          this.onStateUpdate(this.deviceData);

          // Store current state for next comparison
          this.previousState = JSON.parse(JSON.stringify(payload.data));
        }
      } catch (e) {
        this.platform.log.error('Controller: Failed to process MQTT message:', (e as Error).message);
      }
    });

    this.mqttClient.on('error', (err) => {
      this.platform.log.error('Controller: MQTT error:', err.message);

      // Check if it's an authentication error
      if (err.message.includes('Bad username or password') || err.message.includes('Not authorized')) {
        this.platform.log.warn('Controller: MQTT authentication failed - token may have expired');

        // Disable auto-reconnect to prevent spam
        if (this.mqttClient) {
          this.mqttClient.options.reconnectPeriod = 0;
        }

        // Schedule token refresh (debounced to prevent multiple attempts)
        if (!this.authErrorHandled) {
          this.authErrorHandled = true;
          setTimeout(() => {
            this.handleAuthError().then(() => {
              this.authErrorHandled = false;
            });
          }, 1000);
        }
      }
    });

    this.mqttClient.on('close', () => {
      this.platform.log.warn('Controller: MQTT connection closed');

      this.platform.reconnectCount++;
      this.platform.reconnectTimestamps.push(Date.now());

      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      this.platform.reconnectTimestamps = this.platform.reconnectTimestamps.filter(t => t > oneHourAgo);

      if (this.platform.reconnectTimestamps.length > 10) {
        this.platform.log.error(
          `Controller: MQTT reconnected ${this.platform.reconnectTimestamps.length} times in the last hour - check network stability`,
        );

        // If reconnecting too much, try refreshing token
        if (this.platform.reconnectTimestamps.length > 50) {
          this.platform.log.warn('Controller: Excessive reconnections detected - attempting token refresh');
          this.handleAuthError();
        }
      }

      if (this.stateRequestInterval) {
        clearInterval(this.stateRequestInterval);
        this.stateRequestInterval = null;
      }
      this.activatePollingFallback();
    });
  }

  /**
   * Log state changes for areas, zones, PGMs, and utilities
   */
  private logStateChanges(newState: DeviceState): void {
    if (!this.previousState) {
      return; // First state received, nothing to compare
    }

    const deviceProfile = this.deviceData?.deviceProfile;
    const zoneLabels = deviceProfile?.zonesLabels || [];

    // Check area state changes
    if (newState.areas && this.previousState.areas) {
      newState.areas.forEach((area, index) => {
        const prevArea = this.previousState!.areas[index];
        if (area !== prevArea) {
          const areaName = `Area ${index + 1}`;
          const stateNames: Record<string, string> = {
            'disarm': 'Disarmed',
            'arm': 'Armed Away',
            'stay': 'Armed Stay',
            'sleep': 'Armed Night',
            'alarm': 'ALARM TRIGGERED',
            'countdown': 'Exit Countdown',
          };
          this.platform.log.info(`🔒 ${areaName}: ${stateNames[prevArea] || prevArea} → ${stateNames[area] || area}`);
        }
      });
    }

    // Check zone state changes
    if (newState.zones && this.previousState.zones) {
      newState.zones.forEach((zone, index) => {
        const prevZone = this.previousState!.zones[index];
        if (zone !== prevZone) {
          const zoneNum = index + 1;
          const zoneName = zoneLabels[index] || `Zone ${zoneNum}`;

          // Map zone states to readable descriptions
          const zoneStateMap: Record<string, string> = {
            'r': 'Ready (Closed)',
            'a': 'Active (Open)',
            'b': 'Bypassed',
            't': 'Tampered',
            'f': 'Fault',
          };

          const prevStateDesc = zoneStateMap[prevZone] || prevZone;
          const newStateDesc = zoneStateMap[zone] || zone;

          // Use different emoji based on event type
          let emoji = '🚪';
          if (zone === 'a' && zoneName.toLowerCase().includes('pir')) {
            emoji = '🚶';
          } else if (zone === 'b') {
            emoji = '⏭️';
          } else if (zone === 't' || zone === 'f') {
            emoji = '⚠️';
          }

          this.platform.log.info(`${emoji} ${zoneName}: ${prevStateDesc} → ${newStateDesc}`);
        }
      });
    }

    // Check PGM (Programmable Output) state changes
    if (newState.pgms && this.previousState.pgms) {
      newState.pgms.forEach((pgm, index) => {
        const prevPgm = this.previousState!.pgms![index];
        if (pgm !== prevPgm) {
          const pgmName = `PGM ${index + 1}`;
          const pgmState = pgm === 'a' ? 'Activated' : 'Deactivated';
          this.platform.log.info(`⚡ ${pgmName}: ${pgmState}`);
        }
      });
    }

    // Check utility states (AC power, battery, etc.)
    if (newState.utility && this.previousState.utility) {
      newState.utility.forEach((util, index) => {
        const prevUtil = this.previousState!.utility![index];
        if (util !== prevUtil) {
          const utilityNames = ['AC Power', 'Battery Low', 'Tamper', 'Phone Line'];
          const utilName = utilityNames[index] || `Utility ${index + 1}`;
          const utilState = util === 'a' ? 'FAULT' : 'OK';
          const emoji = util === 'a' ? '🔴' : '🟢';
          this.platform.log.info(`${emoji} ${utilName}: ${utilState}`);
        }
      });
    }
  }

  /**
   * Start periodic state requests over MQTT
   */
  private startPeriodicStateRequests(imei: string): void {
    if (this.stateRequestInterval) {
      clearInterval(this.stateRequestInterval);
    }

    this.requestMqttState(imei);
    this.stateRequestInterval = setInterval(() => {
      this.requestMqttState(imei);
    }, 30000);

    this.platform.log.info('Controller: Started periodic state requests');
  }

  /**
   * Request state update via MQTT
   */
  private requestMqttState(imei: string): void {
    if (this.mqttClient && this.mqttClient.connected) {
      const statusTopic = `si/app/v2/${imei}/status`;
      const message = JSON.stringify({ method: 'GET' });
      this.mqttClient.publish(statusTopic, message, { qos: 1 });
      this.platform.log.debug('Controller: State request sent');
    }
  }

  /**
   * Refresh device state (via MQTT or API fallback)
   */
  async refreshState(): Promise<void> {
    if (this.mqttClient && this.mqttClient.connected) {
      const device = this.auth?.getDevice();
      if (!device) {
        return;
      }
      this.requestMqttState(device.IMEI);
    } else {
      const apiKey = this.platform.config.fallbackAuth?.apiKey;
      if (!apiKey) {
        this.platform.log.warn('Controller: API polling unavailable (no API key configured)');
        return;
      }
      try {
        const response = await axios.get(
          `${PUBLIC_API_BASE_URL}/devices/${this.platform.config.deviceId}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (response.data) {
          this.platform.log.info('Controller: Received device update via API polling');
          this.deviceData = response.data;
          if (this.deviceData) {
            this.onStateUpdate(this.deviceData);
          }
        }
      } catch (e) {
        this.platform.log.error(`Controller: API polling failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Send command to device (via MQTT or API)
   */
  async sendCommand(action: string, zoneNum = 1): Promise<void> {
    const areaNum = 1;

    // Force zone bypass/unbypass to always use API
    if (action.includes('zone-bypass') || action.includes('zone-unbypass')) {
      const apiKey = this.platform.config.fallbackAuth?.apiKey;
      if (!apiKey) {
        this.platform.log.error('API key required for zone bypass commands');
        return;
      }
      const number = zoneNum;
      this.platform.log.info(`Sending API request: actionCmd="${action}", actionNum=${number}`);
      try {
        await axios.post(
          `${PUBLIC_API_BASE_URL}/devices/${this.platform.config.deviceId}/actions`,
          { actionCmd: action, actionNum: number },
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        this.platform.log.info(`Controller: Command [${action}] sent via API for zone ${number}`);
      } catch (e) {
        this.platform.log.error(`Controller: API command failed: ${(e as Error).message}`);
        this.platform.log.error(`Failed request: actionCmd="${action}", actionNum=${number}`);
      }
      return;
    }

    if (this.mqttClient && this.mqttClient.connected) {
      const device = this.auth?.getDevice();
      if (!device) {
        return;
      }
      const topic = `si/app/v2/${device.IMEI}/control`;
      const number = action.includes('zone') ? zoneNum : areaNum;
      const payload = { method: 'POST', data: [action, number] };
      this.mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 });
      this.platform.log.info(`Controller: Sent command [${action}]${action.includes('zone') ? ` for zone ${zoneNum}` : ''}`);
    } else {
      this.platform.log.warn('Controller: MQTT disconnected, trying fallback API');
      const apiKey = this.platform.config.fallbackAuth?.apiKey;
      if (!apiKey) {
        return;
      }
      const number = action.includes('zone') ? zoneNum : areaNum;
      try {
        await axios.post(
          `${PUBLIC_API_BASE_URL}/devices/${this.platform.config.deviceId}/actions`,
          { actionCmd: action, actionNum: number },
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        this.platform.log.info(`Controller: Command [${action}] sent via API`);
      } catch (e) {
        this.platform.log.error(`Controller: API command failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Activate API polling as fallback when MQTT is unavailable
   */
  activatePollingFallback(): void {
    const interval = (this.platform.config.pollingInterval || 300) * 1000;
    if (interval > 0 && !this.pollingTimer) {
      this.refreshState();
      this.platform.log.info(`Controller: Polling activated (every ${interval / 1000}s)`);
      this.pollingTimer = setInterval(() => {
        this.refreshState();
      }, interval);
    }
  }

  /**
   * Deactivate API polling when MQTT is active
   */
  deactivatePollingFallback(): void {
    if (this.pollingTimer) {
      this.platform.log.info('Controller: Polling deactivated (MQTT active)');
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Handle authentication errors by refreshing token and reconnecting
   */
  private async handleAuthError(): Promise<void> {
    if (!this.auth) {
      return;
    }

    this.platform.log.info('Controller: Refreshing authentication token...');

    try {
      // Disconnect existing MQTT client to stop reconnect loop
      if (this.mqttClient) {
        this.mqttClient.removeAllListeners();
        this.mqttClient.end(true);
        this.mqttClient = null;
      }

      // Refresh the access token
      await this.auth.ensureAccessTokenIsValid();

      this.platform.log.info('Controller: Token refreshed successfully, reconnecting to MQTT...');

      // Reconnect with new token
      this.connect(this.auth);
    } catch (error) {
      this.platform.log.error(`Controller: Failed to refresh token: ${(error as Error).message}`);
      this.platform.log.warn('Controller: Falling back to API polling');
      this.activatePollingFallback();
    }
  }

  /**
   * Register event listener for state updates
   */
  on(event: string, callback: (deviceData: DeviceData) => void): void {
    if (event === 'stateUpdate') {
      this.onStateUpdate = callback;
    }
  }
}