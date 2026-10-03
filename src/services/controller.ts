import mqtt from 'mqtt';
import axios, { AxiosInstance } from 'axios';
import { API_BASE_URL, DEFAULT_MQTT_CLIENT_ID_SUFFIX, MQTT_URL, MQTT_USERNAME } from '../settings.js';
import type { OlarmPlatform } from '../platform.js';
import type { DeviceData, DeviceState, OlarmDevicesResponse, OlarmMqttPayload } from '../types.js';

/**
 * Timeout for Olarm REST API requests. Kept short so a HomeKit request that
 * waits on them still answers within HomeKit's ~10s limit.
 */
const API_TIMEOUT_MS = 4000;

/**
 * Delay between MQTT reconnect attempts, and between retries of the initial
 * account lookup needed to connect.
 */
const MQTT_RECONNECT_MS = 10000;
const MQTT_RECONNECT_MAX_MS = 5 * 60 * 1000;
const START_RETRY_MS = 60000;

/**
 * HomeKit-style area commands mapped to Olarm public API action commands
 */
const AREA_ACTIONS: Record<string, string> = {
  arm: 'area-arm',
  stay: 'area-stay',
  sleep: 'area-sleep',
  disarm: 'area-disarm',
};

/**
 * OlarmController
 * Talks to the Olarm public API: device state and commands over REST
 * (https://api.olarm.com/api/v4), and real-time state over the public MQTT
 * feed. MQTT only pushes changes, so the REST API is used for the initial
 * state, to resync after reconnecting, and as a polling fallback.
 */
export class OlarmController {
  public mqttClient: mqtt.MqttClient | null = null;
  public pollingTimer: NodeJS.Timeout | null = null;
  public deviceData: DeviceData | null = null;
  private onStateUpdate: (deviceData: DeviceData) => void = () => { };
  private previousState: DeviceState | null = null;
  private readonly http: AxiosInstance;
  private startRetryTimer: NodeJS.Timeout | null = null;
  private reconnectTimestamps: number[] = [];
  private connectedSinceAttempt = false;
  private failedAttempts = 0;
  private stopped = false;

  constructor(
    private readonly platform: OlarmPlatform,
    private readonly apiKey: string,
  ) {
    this.http = axios.create({
      baseURL: API_BASE_URL,
      timeout: API_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  private get deviceId(): string {
    return this.platform.config.deviceId;
  }

  get isMqttConnected(): boolean {
    return !!this.mqttClient?.connected;
  }

  /**
   * Look up the account's user id (needed for the MQTT client id) and confirm
   * the configured device is accessible, then connect to the MQTT feed.
   * Retries in the background if the API can't be reached.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      return;
    }

    let account: OlarmDevicesResponse;
    try {
      const response = await this.http.get<OlarmDevicesResponse>('/devices', {
        params: { page: 1, pageLength: 100, deviceApiAccessOnly: 1 },
      });
      account = response.data;
    } catch (e) {
      this.platform.log.error(`Controller: Could not fetch devices from the Olarm API: ${(e as Error).message}. Retrying in 60s.`);
      this.activatePollingFallback();
      this.startRetryTimer = setTimeout(() => this.start(), START_RETRY_MS);
      return;
    }

    const devices = account.data ?? [];
    if (!devices.some(d => d.deviceId === this.deviceId)) {
      this.platform.log.error(
        `Controller: Device "${this.deviceId}" was not found among the devices this API key can access. ` +
        'Make sure API access is enabled for it in the Olarm user portal. Available devices: ' +
        (devices.map(d => `${d.deviceName ?? 'unnamed'} (${d.deviceId})`).join(', ') || 'none'),
      );
      return;
    }

    if (!account.userId) {
      this.platform.log.error('Controller: The Olarm API did not return a user id; cannot connect to MQTT. Using API polling.');
      this.activatePollingFallback();
      return;
    }

    this.connectMqtt(account.userId);
  }

  /**
   * Connect to the public MQTT feed and subscribe to the device
   */
  private connectMqtt(userId: string): void {
    const suffix = this.platform.config.mqttClientIdSuffix || DEFAULT_MQTT_CLIENT_ID_SUFFIX;
    const topic = `v4/devices/${this.deviceId}`;

    const clientId = `${userId}-${suffix}`;
    this.platform.log.info('Controller: Connecting to Olarm MQTT feed...');
    this.platform.log.debug(`Controller: MQTT client id "${clientId}", topic "${topic}"`);
    this.mqttClient = mqtt.connect(MQTT_URL, {
      username: MQTT_USERNAME,
      password: this.apiKey,
      clientId,
      protocolVersion: 4,
      reconnectPeriod: MQTT_RECONNECT_MS,
      connectTimeout: 10000,
      clean: true,
      keepalive: 30,
    });

    this.mqttClient.on('connect', () => {
      this.platform.log.info('Controller: MQTT connected');
      this.connectedSinceAttempt = true;
      this.failedAttempts = 0;
      this.mqttClient!.options.reconnectPeriod = MQTT_RECONNECT_MS;
      this.mqttClient!.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          this.platform.log.error('Controller: MQTT subscription failed:', err.message);
          return;
        }
        this.platform.log.info('Controller: Subscribed to device updates');
        this.deactivatePollingFallback();
        // MQTT only pushes changes; resync anything missed while disconnected
        this.refreshState();
      });
    });

    this.mqttClient.on('message', (_topic, message) => {
      try {
        const payload = JSON.parse(message.toString()) as OlarmMqttPayload;
        this.platform.log.debug(`Controller: MQTT message with fields: ${Object.keys(payload).join(', ') || '(none)'}`);
        if (!this.deviceData) {
          return;
        }
        let updated = false;
        if (payload.deviceState) {
          this.applyState(payload.deviceState);
          updated = true;
        }
        if (payload.deviceStatus) {
          this.deviceData.deviceStatus = payload.deviceStatus;
          updated = true;
        }
        if (payload.deviceProfile) {
          this.deviceData.deviceProfile = payload.deviceProfile;
        }
        if (updated) {
          this.platform.log.debug('Controller: Processing MQTT state update');
          this.onStateUpdate(this.deviceData);
        }
      } catch (e) {
        this.platform.log.error('Controller: Failed to process MQTT message:', (e as Error).message);
      }
    });

    this.mqttClient.on('error', (err) => {
      const code = (err as { code?: number }).code;
      const isAuthError = code === 4 || code === 5 || code === 134 || code === 135 ||
        err.message.includes('Not authorized') || err.message.includes('Bad username or password');

      if (isAuthError) {
        // The API key doesn't expire, so retrying with it won't help
        this.platform.log.error(
          'Controller: The Olarm MQTT broker rejected the connection. Check the API key, and that ' +
          '"mqttClientIdSuffix" is not used by another Olarm integration on this account. Using API polling instead.',
        );
        this.mqttClient?.end(true);
        this.activatePollingFallback();
        return;
      }
      this.platform.log.error('Controller: MQTT error:', err.message);
    });

    this.mqttClient.on('close', () => {
      if (this.stopped) {
        return;
      }
      this.activatePollingFallback();

      if (!this.connectedSinceAttempt) {
        // The broker closes the connection without an error when it rejects the
        // credentials or client id, so back off rather than retrying every 10s
        this.failedAttempts++;
        const delay = Math.min(MQTT_RECONNECT_MS * 2 ** (this.failedAttempts - 1), MQTT_RECONNECT_MAX_MS);
        if (this.mqttClient) {
          this.mqttClient.options.reconnectPeriod = delay;
        }
        const message = `Controller: Could not connect to the Olarm MQTT feed (attempt ${this.failedAttempts}); retrying in ${delay / 1000}s. ` +
          'If this persists, check the API key, and that "mqttClientIdSuffix" is not used by another Olarm integration on this account.';
        if (this.failedAttempts === 1 || this.failedAttempts % 10 === 0) {
          this.platform.log.error(message);
        } else {
          this.platform.log.debug(message);
        }
        return;
      }
      this.connectedSinceAttempt = false;
      this.platform.log.warn('Controller: MQTT connection closed');

      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      this.reconnectTimestamps = this.reconnectTimestamps.filter(t => t > oneHourAgo);
      this.reconnectTimestamps.push(Date.now());
      if (this.reconnectTimestamps.length > 10) {
        this.platform.log.error(
          `Controller: MQTT disconnected ${this.reconnectTimestamps.length} times in the last hour - ` +
          'check network stability, or whether another client uses the same "mqttClientIdSuffix"',
        );
      }
    });
  }

  /**
   * Fetch the device's full state from the REST API.
   * Returns true if fresh state was received.
   */
  async refreshState(): Promise<boolean> {
    try {
      const response = await this.http.get<DeviceData>(`/devices/${this.deviceId}`, {
        params: { deviceApiAccessOnly: 1 },
      });
      const data = response.data;
      if (!data?.deviceState) {
        this.platform.log.error('Controller: Olarm API returned no device state');
        return false;
      }
      this.platform.log.debug(`Controller: Received device state from API (deviceStatus: ${data.deviceStatus ?? '(not provided)'})`);
      this.deviceData = data;
      this.applyState(data.deviceState);
      this.onStateUpdate(this.deviceData);
      return true;
    } catch (e) {
      this.platform.log.error(`Controller: Fetching device state failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Store a new device state, logging what changed since the last one
   */
  private applyState(newState: DeviceState): void {
    this.logStateChanges(newState);
    this.deviceData!.deviceState = newState;
    this.previousState = JSON.parse(JSON.stringify(newState));
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
            'notready': 'Disarmed (Not Ready)',
            'arm': 'Armed Away',
            'stay': 'Armed Stay',
            'sleep': 'Armed Night',
            'alarm': 'ALARM TRIGGERED',
            'emergency': 'EMERGENCY',
            'fire': 'FIRE ALARM',
            'medical': 'MEDICAL ALARM',
            'countdown': 'Exit Countdown',
            'entrydelay': 'Entry Delay',
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
            'c': 'Closed',
            'a': 'Active (Open)',
            'b': 'Bypassed',
          };

          const prevStateDesc = zoneStateMap[prevZone] || prevZone;
          const newStateDesc = zoneStateMap[zone] || zone;

          // Use different emoji based on event type
          let emoji = '🚪';
          if (zone === 'a' && zoneName.toLowerCase().includes('pir')) {
            emoji = '🚶';
          } else if (zone === 'b') {
            emoji = '⏭️';
          } else if (!(zone in zoneStateMap)) {
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
   * Check whether a PGM may be pulsed, from the panel profile's pgmControl flags.
   * Returns a reason if not, or null if pulsing is allowed.
   */
  pgmPulseProblem(pgmNum: number): string | null {
    const controls = this.deviceData?.deviceProfile?.pgmControl;
    if (!controls) {
      return 'the panel profile has no PGM information (deviceProfile.pgmControl)';
    }
    const control = controls[pgmNum - 1] || '000';
    if (control[0] !== '1') {
      return `PGM ${pgmNum} is not enabled on the panel`;
    }
    if (control[2] !== '1') {
      return `PGM ${pgmNum} does not allow pulse control`;
    }
    return null;
  }

  /**
   * Pulse a PGM. Unlike sendCommand, failures are thrown so the caller can
   * report them to HomeKit. A timeout does not guarantee the pulse was not delivered.
   */
  async pulsePgm(pgmNum: number): Promise<void> {
    const problem = this.pgmPulseProblem(pgmNum);
    if (problem) {
      throw new Error(`Refusing to pulse: ${problem}`);
    }
    await this.postAction('pgm-pulse', pgmNum);
    this.platform.log.info(`Controller: Command [pgm-pulse] sent for PGM ${pgmNum}`);
  }

  /**
   * Send an area or zone command. Area commands ('arm', 'stay', 'sleep',
   * 'disarm') act on area 1; zone commands ('zone-bypass', 'zone-unbypass')
   * act on the given zone. Failures are logged.
   */
  async sendCommand(action: string, zoneNum = 1): Promise<void> {
    const areaCommand = AREA_ACTIONS[action];
    const actionCmd = areaCommand ?? action;
    const actionNum = areaCommand ? 1 : zoneNum;

    try {
      await this.postAction(actionCmd, actionNum);
      this.platform.log.info(`Controller: Command [${actionCmd}] sent for ${areaCommand ? 'area' : 'zone'} ${actionNum}`);
    } catch (e) {
      this.platform.log.error(`Controller: Command [${actionCmd}] for ${actionNum} failed: ${(e as Error).message}`);
    }
  }

  private async postAction(actionCmd: string, actionNum: number): Promise<void> {
    this.platform.log.debug(`Controller: POST /devices/${this.deviceId}/actions { actionCmd: "${actionCmd}", actionNum: ${actionNum} }`);
    try {
      const response = await this.http.post(`/devices/${this.deviceId}/actions`, { actionCmd, actionNum });
      this.platform.log.debug(`Controller: [${actionCmd} ${actionNum}] HTTP ${response.status}`);
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      this.platform.log.debug(`Controller: [${actionCmd} ${actionNum}] failed: ${status ? `HTTP ${status}` : (e as Error).message}`);
      throw e;
    }
  }

  /**
   * Activate API polling as fallback when MQTT is unavailable
   */
  activatePollingFallback(): void {
    const interval = (this.platform.config.pollingInterval || 300) * 1000;
    if (interval > 0 && !this.pollingTimer && !this.stopped) {
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
   * Disconnect and stop all timers
   */
  stop(): void {
    this.stopped = true;
    this.mqttClient?.end(true);
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.startRetryTimer) {
      clearTimeout(this.startRetryTimer);
      this.startRetryTimer = null;
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
