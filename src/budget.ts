import { ByokError } from "./errors.js";

export interface Reservation {
  readonly id: number;
  readonly amountUsd: number;
}

export interface BudgetSnapshot {
  limitUsd: number;
  spentUsd: number;
  /** Held for requests still in flight. */
  reservedUsd: number;
  remainingUsd: number;
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.0001) return "under $0.0001";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * A spending cap for one page session. Each request reserves its worst-case
 * cost before it is sent, so requests running at the same time can't overshoot
 * the cap together. When the response arrives the reservation is replaced with
 * the real cost.
 */
export class SessionBudget {
  readonly limitUsd: number;
  #spent = 0;
  #reservations = new Map<number, number>();
  #nextId = 1;

  constructor(limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new ByokError("bad_config", "The session budget must be a positive number of dollars.");
    }
    this.limitUsd = limitUsd;
  }

  get spentUsd(): number {
    return this.#spent;
  }

  get reservedUsd(): number {
    let total = 0;
    for (const amount of this.#reservations.values()) total += amount;
    return total;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.#spent - this.reservedUsd);
  }

  snapshot(): BudgetSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.#spent,
      reservedUsd: this.reservedUsd,
      remainingUsd: this.remainingUsd,
    };
  }

  /** Hold `amountUsd` for a request, or throw if that would pass the limit. */
  reserve(amountUsd: number): Reservation {
    if (amountUsd > this.remainingUsd) {
      const left = this.remainingUsd;
      throw new ByokError(
        "budget_exceeded",
        left < 0.0001
          ? `This session's ${formatUsd(this.limitUsd)} budget is used up (${formatUsd(this.#spent)} spent). No more requests will be sent from this page.`
          : `This request could cost up to ${formatUsd(amountUsd)}, but only ${formatUsd(left)} of this session's ${formatUsd(this.limitUsd)} budget is left. Ask for a shorter answer or start a new session.`,
      );
    }
    const id = this.#nextId++;
    this.#reservations.set(id, amountUsd);
    return { id, amountUsd };
  }

  /** Replace a reservation with what the request really cost. */
  settle(reservation: Reservation, actualUsd: number): void {
    if (!this.#reservations.delete(reservation.id)) return;
    this.#spent += Math.max(0, actualUsd);
  }

  /** Drop a reservation for a request that was never billed. */
  release(reservation: Reservation): void {
    this.#reservations.delete(reservation.id);
  }
}
