/**
 * Bootstrap do Sistema de Tasks (T1.2). [design.md §2.3 SEC-108]
 * Roda MANUALMENTE (você, JP) DEPOIS de aplicar o 001_init.sql em dev:
 *   ADMIN_EMAIL=voce@empresa.com ADMIN_NAME="Seu Nome" npm run db:seed
 *
 * Cria: organização, perfil "Administrador" (isSystem, catálogo completo) e 1 admin
 * com SENHA TEMPORÁRIA de alta entropia + mustChangePassword=true. A senha é impressa
 * UMA vez no console — copie e entregue por canal próprio. Ninguém conhece a senha definitiva.
 * Idempotente: se já houver organização, não faz nada.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { ALL_PERMISSIONS } from "@sistema-tasks/contracts";

const prisma = new PrismaClient();

function genTempPassword(): string {
  // ~22 chars base64url de alta entropia
  return randomBytes(16).toString("base64url");
}

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const name = process.env.ADMIN_NAME ?? "Administrador";
  const orgName = process.env.ORG_NAME ?? "Minha Empresa";

  if (!email) {
    throw new Error("Defina ADMIN_EMAIL (e opcionalmente ADMIN_NAME, ORG_NAME).");
  }

  const existing = await prisma.organization.findFirst();
  if (existing) {
    console.log("Já existe uma organização — bootstrap ignorado (idempotente).");
    return;
  }

  const org = await prisma.organization.create({ data: { name: orgName } });

  const adminRole = await prisma.role.create({
    data: {
      orgId: org.id,
      name: "Administrador",
      isSystem: true,
      permissions: ALL_PERMISSIONS,
    },
  });

  const tempPassword = genTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      name,
      email,
      passwordHash,
      roleId: adminRole.id,
      mustChangePassword: true,
    },
  });

  console.log("\n=== Bootstrap concluído ===");
  console.log(`Organização: ${org.name} (${org.id})`);
  console.log(`Admin:       ${admin.email}`);
  console.log(`Senha TEMPORÁRIA (copie agora, não será exibida de novo):\n\n    ${tempPassword}\n`);
  console.log("O admin troca essa senha obrigatoriamente no 1º login.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
