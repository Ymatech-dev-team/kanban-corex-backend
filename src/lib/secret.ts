import { randomBytes } from "node:crypto";

/** Senha temporária de alta entropia (base64url ~22 chars). */
export function genTempPassword(): string {
  return randomBytes(16).toString("base64url");
}
