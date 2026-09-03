import { describe, it, expect } from "vitest";
import { AppError } from "../src/lib/errors.js";

describe("AppError → status HTTP", () => {
  it("mapeia cada código para o status certo", () => {
    expect(new AppError("VALIDACAO", "x").statusCode).toBe(400);
    expect(new AppError("NAO_AUTENTICADO", "x").statusCode).toBe(401);
    expect(new AppError("SEM_PERMISSAO", "x").statusCode).toBe(403);
    expect(new AppError("NAO_ENCONTRADO", "x").statusCode).toBe(404);
    expect(new AppError("CONFLITO", "x").statusCode).toBe(409);
    expect(new AppError("MUITAS_TENTATIVAS", "x").statusCode).toBe(429);
  });
});
