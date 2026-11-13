import {describe,it,expect} from "vitest";
import {MCP_SCOPES} from "../src/modules/mcp/oauth/provider.js";
import {renderConsent} from "../src/modules/mcp/oauth/consent-view.js";
describe("autonomous completion consent",()=>{
 it("advertises dedicated approval scope",()=>{expect(MCP_SCOPES).toContain("tasks:approve");});
 it("clearly explains delegated completion only when requested",()=>{
  const page=(scopes:string[])=>renderConsent({clientId:"Claude or Codex",scopes,csrf:"test",nonce:"test"});
  expect(page(["tasks:approve"])).toContain("Aprovar revisões e concluir tarefas");
  expect(page(["tasks:approve"])).toContain("checks falhos, pendentes ou ausentes e achados bloqueantes");
  expect(page(["tasks:update"])).toContain("não permite concluir tarefas");
  expect(page(["tasks:update"])).not.toContain("Aprovar revisões e concluir tarefas");
 });
});
