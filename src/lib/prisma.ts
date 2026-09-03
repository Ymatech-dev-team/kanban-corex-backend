import { Pool, neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";
import ws from "ws";

// Driver serverless do Neon (HTTP/WS) — contorna o pool TCP e o footgun de
// transação sobre o pooler. [design.md §5 ARQ, DA1]
neonConfig.webSocketConstructor = ws;

let client: PrismaClient | undefined;

/** Singleton preguiçoso: só conecta quando a 1ª rota de domínio usar (testes não tocam o banco). */
export function getPrisma(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL não definido");
    }
    const pool = new Pool({ connectionString });
    const adapter = new PrismaNeon(pool);
    client = new PrismaClient({ adapter });
  }
  return client;
}
