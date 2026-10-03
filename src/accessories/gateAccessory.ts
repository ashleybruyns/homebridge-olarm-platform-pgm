import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { OlarmPlatform } from '../platform.js';
import type { OlarmAccessoryContext, GateConfig } from '../types.js';

type GatePosition = 'open' | 'closed' | 'unknown';

/**
 * A zone reading older than this is not trusted to decide whether to pulse;
 * a fresh one is fetched from the API first.
 */
const STATE_MAX_AGE_MS = 90 * 1000;

/**
 * OlarmGate
 * Represents a gate as a HomeKit Garage Door Opener.
 *
 * The PGM driving the gate motor is a momentary pulse that toggles the gate
 * (and stops or reverses it if pulsed mid-travel), so it carries no state of
 * its own. The configured zone is the only source of truth for the gate's
 * position, and the PGM is pulsed only when that is safe:
 *  - the zone reading is exactly closed ('c') or open ('a') - bypassed ('b'),
 *    tampered, faulted or missing readings are treated as unknown;
 *  - the reading is recent and the panel is online;
 *  - no other movement is in progress (a lockout covers the whole operation
 *    time, including after a failed or timed-out pulse whose outcome is unknown);
 *  - the PGM is enabled and allows pulsing (checked by controller.pulsePgm);
 *  - the requested position differs from the current one.
 * Anything else is refused with an error so HomeKit shows "No Response"
 * rather than the gate moving unexpectedly.
 */
export class OlarmGate {
  private service: Service;
  public config: GateConfig | null = null;

  private position: GatePosition = 'unknown';
  private lastReadingAt = 0;
  private deviceOnline = false;

  /** Position requested by the movement in progress; non-null while locked out. */
  private movingTo: 'open' | 'closed' | null = null;
  private movementTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: OlarmPlatform,
    public readonly accessory: PlatformAccessory<OlarmAccessoryContext>,
  ) {
    const { Characteristic, Service } = this.platform.api.hap;

    this.accessory.category = this.platform.api.hap.Categories.GARAGE_DOOR_OPENER;

    // Set accessory information
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Olarm')
      .setCharacteristic(Characteristic.Model, 'Gate')
      .setCharacteristic(Characteristic.FirmwareRevision, this.accessory.context.firmware);

    // Get or create the GarageDoorOpener service
    this.service = this.accessory.getService(Service.GarageDoorOpener) ||
      this.accessory.addService(Service.GarageDoorOpener, this.accessory.displayName);

    // HAP defaults both states to OPEN; report Stopped until the zone confirms the position
    this.service.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.STOPPED);

    this.service.getCharacteristic(Characteristic.CurrentDoorState)
      .onGet(() => this.service.getCharacteristic(Characteristic.CurrentDoorState).value as CharacteristicValue);

    this.service.getCharacteristic(Characteristic.ObstructionDetected)
      .onGet(() => false);

    this.service.getCharacteristic(Characteristic.TargetDoorState)
      .onSet(this.handleTargetSet.bind(this));
  }

  /**
   * Apply the gate's config. Called by the platform on every discovery.
   */
  configure(config: GateConfig): void {
    this.config = config;
    this.accessory.context.zoneNum = config.zone;
    this.accessory.context.pgmNum = config.pgm;
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.api.hap.Characteristic.SerialNumber,
        `${this.accessory.context.deviceId}-gate-z${config.zone}-p${config.pgm}`,
      );
  }

  /**
   * Handle a HomeKit request to open or close the gate.
   */
  private async handleTargetSet(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform.api.hap;
    const target = value === Characteristic.TargetDoorState.OPEN ? 'open' : 'closed';
    const name = this.accessory.displayName;
    const pgmNum = this.accessory.context.pgmNum;

    if (!pgmNum || !this.accessory.context.zoneNum) {
      this.platform.log.error(`${name}: Gate needs both a zone and a PGM configured - ignoring request`);
      throw this.communicationFailure();
    }

    this.platform.log.debug(`${name}: Request to ${target === 'open' ? 'open' : 'close'} - ${this.describeReading()}`);

    // Lockout: never pulse while a movement is in progress. Repeating the same
    // request (double tap, scene re-run, Siri retry) is accepted as a no-op;
    // the opposite request is refused, since a pulse now would stop or reverse the gate.
    if (this.movingTo) {
      if (this.movingTo === target) {
        this.platform.log.info(`${name}: Already ${target === 'open' ? 'opening' : 'closing'} - ignoring repeated request`);
        return;
      }
      this.platform.log.warn(`${name}: Gate is still moving - refusing request to ${target === 'open' ? 'open' : 'close'}`);
      this.revertTargetState(this.movingTo);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    // Claim the lockout before any await so concurrent requests can't both pulse
    this.movingTo = target;

    try {
      if (!this.hasTrustedReading()) {
        this.platform.log.debug(`${name}: Reading not trusted, fetching fresh state from the API`);
        await this.fetchFreshState();
        this.platform.log.debug(`${name}: After refresh - ${this.describeReading()}`);
      }
      if (!this.hasTrustedReading()) {
        this.platform.log.warn(
          `${name}: Gate position is unknown or out of date (zone reading: ${this.position}, ` +
          `panel ${this.deviceOnline ? 'online' : 'offline'}) - refusing to pulse PGM ${pgmNum}`,
        );
        throw this.communicationFailure();
      }

      if (this.position === target) {
        this.platform.log.info(`${name}: Already ${target} - not pulsing PGM`);
        this.showPosition();
        this.movingTo = null;
        return;
      }
    } catch (error) {
      this.movingTo = null;
      this.revertTargetState(this.position);
      throw error;
    }

    this.platform.log.info(`${name}: Pulsing PGM ${pgmNum} to ${target === 'open' ? 'open' : 'close'} gate`);
    this.service.updateCharacteristic(
      Characteristic.CurrentDoorState,
      target === 'open' ? Characteristic.CurrentDoorState.OPENING : Characteristic.CurrentDoorState.CLOSING,
    );

    // Start the lockout timer before sending: if the request fails or times out
    // the pulse may still have reached the panel, so a retry must wait it out.
    this.startMovementTimer();

    try {
      await this.platform.controller.pulsePgm(pgmNum);
    } catch (error) {
      this.platform.log.error(
        `${name}: Failed to pulse PGM ${pgmNum}: ${(error as Error).message}. ` +
        `Further requests are blocked for ${this.operationTimeMs() / 1000}s in case the pulse was delivered.`,
      );
      this.showPosition();
      this.revertTargetState(this.position);
      throw this.communicationFailure();
    }
  }

  /**
   * Update the gate from fresh zone data. Called on every state update.
   */
  updateState(zoneState: string | undefined, deviceStatus: string | undefined): void {
    const { Characteristic } = this.platform.api.hap;
    const reading: GatePosition = zoneState === 'a' ? 'open'
      : zoneState === 'c' ? 'closed'
        : 'unknown';

    this.lastReadingAt = Date.now();
    this.deviceOnline = deviceStatus !== 'offline';
    this.platform.log.debug(`${this.accessory.displayName}: Zone ${this.accessory.context.zoneNum} reads "${zoneState ?? '(missing)'}" (${reading})`);

    if (reading !== this.position) {
      if (reading === 'unknown') {
        this.platform.log.warn(
          `${this.accessory.displayName}: Gate zone reports "${zoneState ?? 'nothing'}" ` +
          '(bypassed, tampered, faulted or missing) - position unknown, gate control disabled',
        );
      } else {
        this.platform.log.info(`${this.accessory.displayName}: ${reading === 'open' ? 'OPENED' : 'CLOSED'}`);
      }
    }
    const previous = this.position;
    this.position = reading;

    // Opened from outside HomeKit (remote, keypad, motor button): the gate has
    // only just left the closed contact and is still travelling, so apply the
    // same lockout as for a HomeKit-initiated open.
    if (!this.movingTo && previous === 'closed' && reading === 'open') {
      this.movingTo = 'open';
      this.startMovementTimer();
      this.service.updateCharacteristic(Characteristic.TargetDoorState, Characteristic.TargetDoorState.OPEN);
      this.service.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPENING);
      return;
    }

    if (this.movingTo) {
      // A close is complete as soon as the closed contact is made. An open is
      // only "not closed" once the gate leaves the contact, so keep showing
      // Opening (and keep the lockout) until the operation time has elapsed.
      if (this.movingTo === 'closed' && reading === 'closed') {
        this.finishMovement();
      }
      return;
    }

    this.showPosition();
    if (reading !== 'unknown') {
      this.service.updateCharacteristic(
        Characteristic.TargetDoorState,
        reading === 'open' ? Characteristic.TargetDoorState.OPEN : Characteristic.TargetDoorState.CLOSED,
      );
    }
  }

  private describeReading(): string {
    const age = this.lastReadingAt ? `${Math.round((Date.now() - this.lastReadingAt) / 1000)}s old` : 'never received';
    return `zone reading: ${this.position} (${age}), panel ${this.deviceOnline ? 'online' : 'offline'}, ` +
      `movement lock: ${this.movingTo ?? 'none'}`;
  }

  private hasTrustedReading(): boolean {
    return this.position !== 'unknown' &&
      this.deviceOnline &&
      Date.now() - this.lastReadingAt <= STATE_MAX_AGE_MS;
  }

  /**
   * Get a current zone reading from the REST API. The MQTT feed only pushes
   * changes, so a quiet feed can't confirm the reading is still current.
   */
  private async fetchFreshState(): Promise<void> {
    await this.platform.controller.refreshState();
  }

  private operationTimeMs(): number {
    return (this.config?.operationTime || 20) * 1000;
  }

  private startMovementTimer(): void {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
    }
    this.movementTimer = setTimeout(() => this.finishMovement(), this.operationTimeMs());
  }

  /**
   * End the lockout and report where the gate actually is.
   */
  private finishMovement(): void {
    const { Characteristic } = this.platform.api.hap;
    const target = this.movingTo;
    this.platform.log.debug(`${this.accessory.displayName}: Movement lock released (target: ${target ?? 'none'}, zone reading: ${this.position})`);

    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
      this.movementTimer = null;
    }
    this.movingTo = null;

    if (target && this.position !== target) {
      this.platform.log.warn(`${this.accessory.displayName}: Gate did not reach ${target} within the operation time`);
      this.service.updateCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.STOPPED);
      return;
    }
    this.showPosition();
  }

  /**
   * Set CurrentDoorState from the zone reading (Stopped when unknown).
   */
  private showPosition(): void {
    const { CurrentDoorState } = this.platform.api.hap.Characteristic;
    const state = this.position === 'open' ? CurrentDoorState.OPEN
      : this.position === 'closed' ? CurrentDoorState.CLOSED
        : CurrentDoorState.STOPPED;
    this.service.updateCharacteristic(CurrentDoorState, state);
  }

  /**
   * After refusing a request, push TargetDoorState back (to the actual position,
   * or the movement in progress) so the Home app doesn't show a request that isn't happening.
   */
  private revertTargetState(target: GatePosition): void {
    const { TargetDoorState } = this.platform.api.hap.Characteristic;
    if (target === 'unknown') {
      return;
    }
    setImmediate(() => {
      this.service.updateCharacteristic(TargetDoorState, target === 'open' ? TargetDoorState.OPEN : TargetDoorState.CLOSED);
    });
  }

  private communicationFailure() {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
