import { AppError } from "../../lib/errors.js";
import type { LockoutStore } from "./types.js";

/**
 * Lockout por conta. O store é persistido (Postgres) — NUNCA in-memory em serverless
 * (cada função tem memória própria → brute-force vaza). Fail-closed: store fora = nega. [SEC-003]
 */
export class LockoutService {
  constructor(private readonly store: LockoutStore) {}

  async assertNotLocked(email: string): Promise<void> {
    let until: Date | null;
    try {
      until = await this.store.lockedUntil(email.toLowerCase());
    } catch {
      // Fail-closed: se o store cair, não liberamos brute-force.
      throw new AppError("MUITAS_TENTATIVAS", "Serviço indisponível. Tente mais tarde.");
    }
    if (until && until.getTime() > Date.now()) {
      throw new AppError("MUITAS_TENTATIVAS", "Muitas tentativas. Aguarde e tente de novo.");
    }
  }

  async recordFailure(email: string): Promise<void> {
    try {
      await this.store.recordFailure(email.toLowerCase());
    } catch {
      /* melhor esforço */
    }
  }

  async recordSuccess(email: string): Promise<void> {
    try {
      await this.store.reset(email.toLowerCase());
    } catch {
      /* melhor esforço */
    }
  }
}
