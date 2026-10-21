/**
 * @chat/ws-state-machine
 * Implements the deterministic WebSocket Client State Machine, Full-Jitter Exponential Backoff,
 * and Heartbeat Zombie Socket Monitor defined in Section 2 of docs/03-frontend-design-specification.md.
 */

export type WsConnectionState =
  | 'DISCONNECTED'
  | 'ACQUIRING_TICKET'
  | 'CONNECTING_WSS'
  | 'DELTA_SYNCING'
  | 'SYNCED_READY'
  | 'RECONNECT_BACKOFF';

export type WsTransitionEvent =
  | 'USER_AUTHENTICATED'
  | 'TICKET_ACQUIRED'
  | 'TICKET_ERROR'
  | 'WS_OPEN_101'
  | 'WS_ERROR_OR_CLOSE'
  | 'DELTA_SYNC_COMPLETE'
  | 'HEARTBEAT_TIMEOUT'
  | 'BACKOFF_TIMER_FIRED'
  | 'USER_LOGOUT';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30000;

/**
 * Calculates exponential backoff delay with Full Jitter:
 * delay = random(0, min(30000ms, 500ms * 2^attempt))
 */
export function calculateBackoffWithFullJitter(
  attempt: number,
  randomFn: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 20));
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, safeAttempt));
  return Math.floor(randomFn() * ceiling);
}

export class WebSocketStateMachine {
  private state: WsConnectionState = 'DISCONNECTED';
  private reconnectAttempts = 0;
  private lastPingSentAt: number | null = null;
  private lastPongReceivedAt: number | null = null;

  public getState(): WsConnectionState {
    return this.state;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  public transition(event: WsTransitionEvent): WsConnectionState {
    switch (event) {
      case 'USER_AUTHENTICATED':
        if (this.state === 'DISCONNECTED' || this.state === 'RECONNECT_BACKOFF') {
          this.state = 'ACQUIRING_TICKET';
        }
        break;

      case 'TICKET_ACQUIRED':
        if (this.state === 'ACQUIRING_TICKET') {
          this.state = 'CONNECTING_WSS';
        }
        break;

      case 'TICKET_ERROR':
        if (this.state === 'ACQUIRING_TICKET') {
          this.reconnectAttempts += 1;
          this.state = 'RECONNECT_BACKOFF';
        }
        break;

      case 'WS_OPEN_101':
        if (this.state === 'CONNECTING_WSS') {
          this.state = 'DELTA_SYNCING';
        }
        break;

      case 'DELTA_SYNC_COMPLETE':
        if (this.state === 'DELTA_SYNCING') {
          this.reconnectAttempts = 0;
          this.state = 'SYNCED_READY';
        }
        break;

      case 'WS_ERROR_OR_CLOSE':
      case 'HEARTBEAT_TIMEOUT':
        if (this.state !== 'DISCONNECTED') {
          this.reconnectAttempts += 1;
          this.state = 'RECONNECT_BACKOFF';
        }
        break;

      case 'BACKOFF_TIMER_FIRED':
        if (this.state === 'RECONNECT_BACKOFF') {
          this.state = 'ACQUIRING_TICKET';
        }
        break;

      case 'USER_LOGOUT':
        this.reconnectAttempts = 0;
        this.lastPingSentAt = null;
        this.lastPongReceivedAt = null;
        this.state = 'DISCONNECTED';
        break;
    }

    return this.state;
  }

  public recordPingSent(nowMs: number = Date.now()): void {
    this.lastPingSentAt = nowMs;
  }

  public recordPongReceived(nowMs: number = Date.now()): void {
    this.lastPongReceivedAt = nowMs;
  }

  /**
   * Returns true if a heartbeat_ping was sent more than timeoutMs (10,000ms) ago
   * without a subsequent heartbeat_pong.
   */
  public isHeartbeatTimedOut(nowMs: number = Date.now(), timeoutMs: number = 10000): boolean {
    if (this.lastPingSentAt === null) return false;
    if (this.lastPongReceivedAt !== null && this.lastPongReceivedAt >= this.lastPingSentAt) {
      return false;
    }
    return nowMs - this.lastPingSentAt >= timeoutMs;
  }
}
