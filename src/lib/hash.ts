import { createHash } from "node:crypto";

/** SHA-256 hex — usado pra guardar hash do refresh token (nunca o token cru). [SEC-004] */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
