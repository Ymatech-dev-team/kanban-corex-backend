import { describe, it, expect } from "vitest";
import { firstLoginSchema, changePasswordSchema } from "@sistema-tasks/contracts";

/**
 * Trava as constraints de senha do contrato (min 8 / max 72). O max 72 evita a falsa sensação de
 * "senha longa" — o bcrypt trunca silenciosamente em 72 bytes. Também pega drift da cópia vendored
 * (se alguém regenerar sem o max, este teste quebra dentro do gate). [hardening T7]
 */
const pw = (n: number) => "a".repeat(n);
const body = (n: number) => ({ currentPassword: "x", newPassword: pw(n), confirmPassword: pw(n) });

describe("contratos de senha — min 8 / max 72", () => {
  for (const [name, schema] of [
    ["firstLogin", firstLoginSchema],
    ["changePassword", changePasswordSchema],
  ] as const) {
    it(`${name}: rejeita menos de 8`, () => {
      expect(schema.safeParse(body(7)).success).toBe(false);
    });
    it(`${name}: aceita de 8 a 72`, () => {
      expect(schema.safeParse(body(8)).success).toBe(true);
      expect(schema.safeParse(body(72)).success).toBe(true);
    });
    it(`${name}: rejeita mais de 72 (bcrypt trunca em 72)`, () => {
      expect(schema.safeParse(body(73)).success).toBe(false);
    });
  }
});
