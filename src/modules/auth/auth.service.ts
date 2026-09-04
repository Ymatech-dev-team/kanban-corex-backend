import { AppError } from "../../lib/errors.js";
import { TokenService } from "./token.service.js";
import { PasswordService } from "./password.service.js";
import { RefreshService } from "./refresh.service.js";
import { LockoutService } from "./lockout.service.js";
import type { UserRepo } from "./types.js";

export interface AuthDeps {
  users: UserRepo;
  tokens: TokenService;
  passwords: PasswordService;
  refresh: RefreshService;
  lockout: LockoutService;
}

const INVALID = () => new AppError("NAO_AUTENTICADO", "email ou senha inválidos");

/** Orquestra login/refresh/logout/first-login. Mensagem de erro genérica (anti-enumeração). */
export class AuthService {
  constructor(private readonly d: AuthDeps) {}

  async login(rawEmail: string, password: string) {
    const email = rawEmail.trim().toLowerCase(); // normaliza (case-insensitive) [SEC-005]
    await this.d.lockout.assertNotLocked(email);

    const user = await this.d.users.findActiveByEmail(email);
    if (!user) {
      await this.d.passwords.dummyVerify(password); // iguala o tempo [SEC-011]
      await this.d.lockout.recordFailure(email);
      throw INVALID();
    }

    const ok = await this.d.passwords.verify(password, user.passwordHash);
    if (!ok) {
      await this.d.lockout.recordFailure(email);
      throw INVALID();
    }

    await this.d.lockout.recordSuccess(email);
    const access = this.d.tokens.signAccess({
      userId: user.id,
      orgId: user.orgId,
      tokenVersion: user.tokenVersion,
    });
    const refresh = await this.d.refresh.issueNewFamily(user.id);
    return { access, refresh, mustChangePassword: user.mustChangePassword };
  }

  async refreshSession(presented: string) {
    const { userId, refresh } = await this.d.refresh.rotate(presented);
    const user = await this.d.users.findById(userId);
    if (!user || user.deletedAt) throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    const access = this.d.tokens.signAccess({
      userId: user.id,
      orgId: user.orgId,
      tokenVersion: user.tokenVersion,
    });
    return { access, refresh };
  }

  async logout(presented: string): Promise<void> {
    await this.d.refresh.revokeFamilyOf(presented);
  }

  /** Trocar a senha estando logado. Bump de tokenVersion + revoga refresh → derruba a sessão atual. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.d.users.findById(userId);
    if (!user || user.deletedAt) throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    const ok = await this.d.passwords.verify(currentPassword, user.passwordHash);
    if (!ok) throw new AppError("NAO_AUTENTICADO", "Senha atual inválida");
    const hash = await this.d.passwords.hash(newPassword);
    await this.d.users.setNewPassword(user.id, hash);
    await this.d.refresh.revokeAllForUser(user.id);
  }

  async updateName(userId: string, name: string): Promise<void> {
    const user = await this.d.users.findById(userId);
    if (!user || user.deletedAt) throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    await this.d.users.updateName(userId, name);
  }

  async firstLogin(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.d.users.findById(userId);
    if (!user || user.deletedAt || !user.mustChangePassword) {
      throw new AppError("SEM_PERMISSAO", "Troca de senha não requerida");
    }
    const ok = await this.d.passwords.verify(currentPassword, user.passwordHash);
    if (!ok) throw new AppError("NAO_AUTENTICADO", "Senha atual inválida");
    const hash = await this.d.passwords.hash(newPassword);
    await this.d.users.setNewPassword(user.id, hash); // limpa flag + bump tokenVersion
    // Mata as sessões existentes de verdade (refresh) — não confia só no bump. [SEC-002]
    await this.d.refresh.revokeAllForUser(user.id);
  }
}
