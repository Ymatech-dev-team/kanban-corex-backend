import { randomUUID } from "node:crypto";
import { TokenService } from "./token.service.js";
import { sha256 } from "../../lib/hash.js";
import { AppError } from "../../lib/errors.js";
import type { NewRefreshToken, RefreshTokenRepo } from "./types.js";

export interface RefreshConfig {
  refreshTtlSec: number;
  familyTtlSec: number; // teto absoluto da família [SEC-012]
  graceMs: number; // tolera refresh concorrente (2 abas) sem matar a família [SEC-004]
}

/** Rotação de refresh com CAS atômico, janela de graça e detecção de replay. [SEC-004] */
export class RefreshService {
  constructor(
    private readonly repo: RefreshTokenRepo,
    private readonly tokens: TokenService,
    private readonly cfg: RefreshConfig,
  ) {}

  private build(
    userId: string,
    family: string,
    inheritedFamilyExpiresAt?: Date,
  ): { raw: string; row: NewRefreshToken } {
    const jti = randomUUID();
    const raw = this.tokens.signRefresh({ userId, jti, family });
    const now = Date.now();
    return {
      raw,
      row: {
        id: jti,
        userId,
        tokenHash: sha256(raw),
        family,
        expiresAt: new Date(now + this.cfg.refreshTtlSec * 1000),
        // Herda o teto ABSOLUTO da família (não desliza a cada rotação). [SEC-003]
        familyExpiresAt: inheritedFamilyExpiresAt ?? new Date(now + this.cfg.familyTtlSec * 1000),
      },
    };
  }

  async issueNewFamily(userId: string): Promise<string> {
    const family = randomUUID();
    const { raw, row } = this.build(userId, family);
    await this.repo.create(row);
    return raw;
  }

  async rotate(presented: string): Promise<{ userId: string; refresh: string }> {
    const claims = this.tokens.verifyRefresh(presented); // sig/exp/iss/aud/typ
    const stored = await this.repo.findByHash(sha256(presented));
    if (!stored) throw new AppError("NAO_AUTENTICADO", "Sessão inválida");

    if (stored.familyExpiresAt.getTime() < Date.now()) {
      await this.repo.revokeFamily(stored.family);
      throw new AppError("NAO_AUTENTICADO", "Sessão expirada");
    }

    if (stored.revokedAt) {
      const age = Date.now() - stored.revokedAt.getTime();
      if (age <= this.cfg.graceMs) {
        // Reuso dentro da janela = concorrência legítima (não é ataque). Não mata a família.
        throw new AppError("NAO_AUTENTICADO", "Refresh concorrente, tente de novo");
      }
      // Reuso de token já rotacionado = REPLAY → revoga a família inteira.
      await this.repo.revokeFamily(stored.family);
      throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    }

    const next = this.build(claims.userId, stored.family, stored.familyExpiresAt);
    const ok = await this.repo.rotate(stored.id, next.row); // CAS atômico
    if (!ok) throw new AppError("NAO_AUTENTICADO", "Refresh concorrente, tente de novo");
    return { userId: claims.userId, refresh: next.raw };
  }

  async revokeFamilyOf(presented: string): Promise<void> {
    const stored = await this.repo.findByHash(sha256(presented));
    if (stored) await this.repo.revokeFamily(stored.family);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.repo.revokeAllForUser(userId);
  }
}
