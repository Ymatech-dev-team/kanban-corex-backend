import jwt from "jsonwebtoken";
import { AppError } from "../../lib/errors.js";

/** Emite/verifica JWT. HS256 fixo, iss/aud validados, claims de access ≠ refresh. [SEC-012] */

export interface TokenConfig {
  accessSecret: string;
  refreshSecret: string;
  issuer: string;
  audience: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

export interface AccessPayload {
  userId: string;
  orgId: string;
  tokenVersion: number; // comparado no authenticate (Escopo 4) → bump derruba a sessão [SEC-007]
}

export interface RefreshPayload {
  userId: string;
  jti: string;
  family: string;
}

export class TokenService {
  constructor(private readonly cfg: TokenConfig) {}

  signAccess(p: AccessPayload): string {
    return jwt.sign({ orgId: p.orgId, tv: p.tokenVersion, typ: "access" }, this.cfg.accessSecret, {
      algorithm: "HS256",
      subject: p.userId,
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
      expiresIn: this.cfg.accessTtlSec,
    });
  }

  signRefresh(p: RefreshPayload): string {
    return jwt.sign({ family: p.family, typ: "refresh" }, this.cfg.refreshSecret, {
      algorithm: "HS256",
      subject: p.userId,
      jwtid: p.jti,
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
      expiresIn: this.cfg.refreshTtlSec,
    });
  }

  verifyAccess(token: string): AccessPayload {
    const d = this.verify(token, this.cfg.accessSecret);
    if (d.typ !== "access" || !d.sub) throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    return { userId: d.sub, orgId: String(d.orgId), tokenVersion: Number(d.tv ?? 0) };
  }

  verifyRefresh(token: string): RefreshPayload {
    const d = this.verify(token, this.cfg.refreshSecret);
    if (d.typ !== "refresh" || !d.sub || !d.jti) {
      throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    }
    return { userId: d.sub, jti: d.jti, family: String(d.family) };
  }

  private verify(token: string, secret: string): jwt.JwtPayload & { typ?: string } {
    try {
      return jwt.verify(token, secret, {
        algorithms: ["HS256"], // trava alg confusion / alg:none
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
      }) as jwt.JwtPayload;
    } catch {
      throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    }
  }
}
