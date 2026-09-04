/** Contratos internos do módulo de auth (repos injetáveis → testável sem banco). */

export interface UserRecord {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  roleId: string | null;
  mustChangePassword: boolean;
  tokenVersion: number;
  deletedAt: Date | null;
}

export interface NewRefreshToken {
  id: string; // = jti
  userId: string;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  familyExpiresAt: Date;
}

export interface StoredRefreshToken extends NewRefreshToken {
  revokedAt: Date | null;
  replacedById: string | null;
}

export interface UserRepo {
  findActiveByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Define nova senha, limpa mustChangePassword e faz bump do tokenVersion (mata sessões). */
  setNewPassword(id: string, passwordHash: string): Promise<void>;
  /** Atualiza o nome do usuário (não mexe em sessão). */
  updateName(id: string, name: string): Promise<void>;
}

export interface RefreshTokenRepo {
  create(token: NewRefreshToken): Promise<void>;
  findByHash(hash: string): Promise<StoredRefreshToken | null>;
  /** CAS atômico: revoga o antigo (se ainda não revogado) e cria o novo. false = corrida perdida. */
  rotate(oldId: string, next: NewRefreshToken): Promise<boolean>;
  revokeFamily(family: string): Promise<void>;
  /** Revoga TODAS as famílias do usuário (troca de senha / remoção). [SEC-007] */
  revokeAllForUser(userId: string): Promise<void>;
}

export interface LockoutStore {
  recordFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  lockedUntil(key: string): Promise<Date | null>;
}
