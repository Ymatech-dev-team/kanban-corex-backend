import { describe, it, expect } from "vitest";
import { signInternal, verifyInternal } from "../src/lib/hmac.js";

const SECRET = "s3cr3t";

describe("HMAC da barreira interna [SEC-002]", () => {
  it("assinatura válida passa", () => {
    const ts = Date.now();
    const sig = signInternal(SECRET, '{"a":1}', ts);
    expect(verifyInternal({ secret: SECRET, body: '{"a":1}', timestamp: ts, signature: sig }).ok).toBe(true);
  });

  it("corpo adulterado falha", () => {
    const ts = Date.now();
    const sig = signInternal(SECRET, '{"a":1}', ts);
    expect(verifyInternal({ secret: SECRET, body: '{"a":2}', timestamp: ts, signature: sig }).ok).toBe(false);
  });

  it("segredo errado falha", () => {
    const ts = Date.now();
    const sig = signInternal(SECRET, "x", ts);
    expect(verifyInternal({ secret: "outro", body: "x", timestamp: ts, signature: sig }).ok).toBe(false);
  });

  it("timestamp fora da janela falha (anti-replay)", () => {
    const ts = Date.now() - 60_000;
    const sig = signInternal(SECRET, "x", ts);
    expect(verifyInternal({ secret: SECRET, body: "x", timestamp: ts, signature: sig }).ok).toBe(false);
  });

  it("assinatura ausente/malformada falha", () => {
    expect(verifyInternal({ secret: SECRET, body: "x", timestamp: Date.now(), signature: "" }).ok).toBe(false);
    expect(verifyInternal({ secret: SECRET, body: "x", timestamp: Date.now(), signature: "zzz" }).ok).toBe(false);
  });
});
