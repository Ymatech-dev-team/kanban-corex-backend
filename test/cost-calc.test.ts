import { describe, it, expect } from "vitest";
import { taskCost } from "../src/modules/cost/calc.js";
import type { CostRow } from "../src/modules/cost/types.js";

function row(over: Partial<CostRow>): CostRow {
  return {
    taskId: "t", status: "TODO", estimatedMinutes: 60, assigneeId: "u1", assigneeName: "Ana",
    compType: "HOURLY", compCents: 4000, assigneeIsMember: true, ...over,
  };
}

describe("taskCost (função pura)", () => {
  it("HOURLY: 60min a R$40/h = R$40,00", () => {
    expect(taskCost(row({}), 176)).toEqual({ state: "OK", cents: 4000 });
  });
  it("HOURLY: 90min a R$40/h = R$60,00", () => {
    expect(taskCost(row({ estimatedMinutes: 90 }), 176)).toEqual({ state: "OK", cents: 6000 });
  });
  it("MONTHLY: R$2500/mês, 176h/mês, 8h de tarefa ≈ salário/22", () => {
    // 250000 * 480 / (176*60) = 11363,63 -> 11364
    expect(taskCost(row({ compType: "MONTHLY", compCents: 250000, estimatedMinutes: 480 }), 176)).toEqual({
      state: "OK",
      cents: 11364,
    });
  });
  it("sem responsável → SEM_RESPONSAVEL, cents null (nunca 0)", () => {
    expect(taskCost(row({ assigneeId: null }), 176)).toEqual({ state: "SEM_RESPONSAVEL", cents: null });
  });
  it("responsável sem acesso → RESPONSAVEL_SEM_ACESSO", () => {
    expect(taskCost(row({ assigneeIsMember: false }), 176).state).toBe("RESPONSAVEL_SEM_ACESSO");
  });
  it("sem horas → SEM_HORAS", () => {
    expect(taskCost(row({ estimatedMinutes: null }), 176).state).toBe("SEM_HORAS");
  });
  it("sem remuneração (null ou <=0) → SEM_REMUNERACAO", () => {
    expect(taskCost(row({ compType: null, compCents: null }), 176).state).toBe("SEM_REMUNERACAO");
    expect(taskCost(row({ compCents: 0 }), 176).state).toBe("SEM_REMUNERACAO");
  });
});
