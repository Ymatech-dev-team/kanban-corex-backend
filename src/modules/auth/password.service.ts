// bcryptjs (JS puro) em vez do bcrypt nativo: roda em runtime serverless (Vercel)
// sem compilação nativa. Hashes são compatíveis ($2b$), então nada precisa remigrar.
import bcrypt from "bcryptjs";

// Hash fixo pra igualar o tempo quando o email não existe (anti-enumeração por timing). [SEC-011]
const DUMMY_HASH = bcrypt.hashSync("timing-equalizer", 12);

export class PasswordService {
  constructor(private readonly cost = 12) {}

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cost);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** Roda um compare "falso" pra gastar o mesmo tempo de um usuário existente. */
  async dummyVerify(plain: string): Promise<void> {
    await bcrypt.compare(plain, DUMMY_HASH);
  }
}
