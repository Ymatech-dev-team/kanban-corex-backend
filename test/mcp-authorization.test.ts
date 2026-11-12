import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { McpAuthorization } from "../src/modules/mcp/authorization.js";

const now = 1_800_000_000;
const issuer = "https://auth.corex.test";
const resource = "https://api.corex.test/mcp";
const claims = () => ({ issuer, audience: resource, expiresAt: now + 300, scopes: ["projects:read", "tasks:read", "tasks:create", "tasks:update"],
  grantId: "grant", clientId: "claude", userId: "user", orgId: "org", tokenVersion: 3 });
const grant = () => ({ id: "grant", userId: "user", orgId: "org", clientId: "claude", revokedAt: null as Date | null,
  expiresAt: now + 3600, scopes: ["projects:read", "tasks:read", "tasks:create", "tasks:update"] });
const user = () => ({ id: "user", orgId: "org", deletedAt: null as Date | null, tokenVersion: 3, mustChangePassword: false,
  rolePermissions: [PERMISSIONS.tarefas_criar, PERMISSIONS.tarefas_editar, PERMISSIONS.tarefas_mover, PERMISSIONS.membros_gerenciar, PERMISSIONS.custos_ver], extraPermissions: [], name: "Person" });
const verifier = { verifyAccessToken: vi.fn() };
const grants = { findById: vi.fn() };
const users = { findById: vi.fn() };
const projects = { findById: vi.fn() };
const access = { isMember: vi.fn(), listAccessibleProjectIds: vi.fn() };
const boundary = () => new McpAuthorization({ issuer, resource, verifier, grants, users, projects, access, now: () => now });

beforeEach(() => {
  vi.resetAllMocks();
  verifier.verifyAccessToken.mockResolvedValue(claims());
  grants.findById.mockResolvedValue(grant());
  users.findById.mockResolvedValue(user());
  projects.findById.mockResolvedValue({ id: "project", orgId: "org", deletedAt: null });
  access.isMember.mockResolvedValue(true);
});

describe("MCP authorization boundary", () => {
  it.each(["approve_review", "adopt_agent_review"])("requires explicit approval consent in token and grant for %s", async (tool) => {
    users.findById.mockResolvedValue({ ...user(), rolePermissions: [PERMISSIONS.tarefas_aprovar] });
    await expect(boundary().authorize("token", tool, "project")).rejects.toMatchObject({code:"SEM_PERMISSAO",message:expect.stringMatching(/reconecte.*tasks:approve/i)});
    verifier.verifyAccessToken.mockResolvedValue({ ...claims(), scopes:[...claims().scopes,"tasks:approve"] });
    await expect(boundary().authorize("token", tool, "project")).rejects.toMatchObject({code:"SEM_PERMISSAO",message:expect.stringMatching(/reconecte.*tasks:approve/i)});
    grants.findById.mockResolvedValue({ ...grant(), scopes:[...grant().scopes,"tasks:approve"] });
    expect((await boundary().authorize("token", tool, "project")).session.permissions.has(PERMISSIONS.tarefas_aprovar)).toBe(true);
    verifier.verifyAccessToken.mockResolvedValue(claims());
    await expect(boundary().authorize("token", tool, "project")).rejects.toMatchObject({code:"SEM_PERMISSAO",message:expect.stringMatching(/reconecte.*tasks:approve/i)});
  });
  it.each(["approve_review", "adopt_agent_review"])("rechecks account permission, tenant and membership for %s", async (tool) => {
    verifier.verifyAccessToken.mockResolvedValue({...claims(),scopes:["tasks:approve"]});
    grants.findById.mockResolvedValue({...grant(),scopes:["tasks:approve"]});
    await expect(boundary().authorize("token",tool,"project")).rejects.toMatchObject({code:"SEM_PERMISSAO"});
    users.findById.mockResolvedValue({...user(),rolePermissions:[PERMISSIONS.tarefas_aprovar]});
    projects.findById.mockResolvedValue({id:"project",orgId:"other",deletedAt:null});
    await expect(boundary().authorize("token",tool,"project")).rejects.toMatchObject({code:"NAO_ENCONTRADO"});
    projects.findById.mockResolvedValue({id:"project",orgId:"org",deletedAt:null});
    access.isMember.mockResolvedValue(false);
    await expect(boundary().authorize("token",tool,"project")).rejects.toMatchObject({code:"NAO_ENCONTRADO"});
  });
  it("delegates correction requests and final evidence only with current permissions", async () => {
    users.findById.mockResolvedValue({...user(),rolePermissions:[PERMISSIONS.tarefas_revisar,PERMISSIONS.tarefas_editar]});
    await expect(boundary().authorize("token","request_changes","project")).resolves.toMatchObject({channel:"MCP"});
    await expect(boundary().authorize("token","record_delivery_evidence","project")).resolves.toMatchObject({channel:"MCP"});
    users.findById.mockResolvedValue({...user(),rolePermissions:[]});
    await expect(boundary().authorize("token","request_changes","project")).rejects.toMatchObject({code:"SEM_PERMISSAO"});
    await expect(boundary().authorize("token","record_delivery_evidence","project")).rejects.toMatchObject({code:"SEM_PERMISSAO"});
  });

  it("delegates technical review only from current role and never human approval", async () => {
    users.findById.mockResolvedValue({ ...user(), rolePermissions: [PERMISSIONS.tarefas_revisar, PERMISSIONS.tarefas_aprovar] });
    const ctx = await boundary().authorize("token", "record_review_findings", "project");
    expect(ctx.session.permissions.has(PERMISSIONS.tarefas_revisar)).toBe(true);
    expect(ctx.session.permissions.has(PERMISSIONS.tarefas_aprovar)).toBe(false);
    users.findById.mockResolvedValue({ ...user(), rolePermissions: [] });
    await expect(boundary().authorize("token", "record_technical_review", "project")).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("constructs a trusted MCP identity and keeps only delegated permissions", async () => {
    const ctx = await boundary().authorize("opaque-token", "update_task", "project");
    expect(ctx.channel).toBe("MCP");
    expect(ctx.connectionId).toBe("grant");
    expect(ctx.session).toMatchObject({ userId: "user", orgId: "org", name: "Person" });
    expect(ctx.session.permissions.has(PERMISSIONS.tarefas_editar)).toBe(true);
    expect(ctx.session.permissions.has(PERMISSIONS.membros_gerenciar)).toBe(false);
    expect(ctx.session.permissions.has(PERMISSIONS.custos_ver)).toBe(false);
  });

  it.each([
    { issuer: "https://wrong.test" }, { audience: "web-app" }, { audience: [] },
    { expiresAt: now }, { expiresAt: Number.NaN }, { tokenVersion: -1 }, { userId: "" },
  ])("rejects invalid dedicated MCP claims %j", async (patch) => {
    verifier.verifyAccessToken.mockResolvedValue({ ...claims(), ...patch });
    await expect(boundary().authorize("token", "get_current_user")).rejects.toMatchObject({ code: "NAO_AUTENTICADO" });
  });

  it("accepts an audience list only when the dedicated resource is present", async () => {
    verifier.verifyAccessToken.mockResolvedValue({ ...claims(), audience: ["other", resource] });
    await expect(boundary().authorize("token", "get_current_user")).resolves.toMatchObject({ channel: "MCP" });
  });

  it("rejects missing/invalid token before reading account data", async () => {
    await expect(boundary().authorize("", "get_current_user")).rejects.toMatchObject({ code: "NAO_AUTENTICADO" });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
    verifier.verifyAccessToken.mockResolvedValue(null);
    await expect(boundary().authorize("bad", "get_current_user")).rejects.toMatchObject({ code: "NAO_AUTENTICADO" });
    expect(users.findById).not.toHaveBeenCalled();
  });

  it.each([
    { revokedAt: new Date() }, { expiresAt: now }, { userId: "another" },
    { orgId: "another" }, { clientId: "another" }, { id: "another" },
  ])("rejects revoked/expired/mismatched grants %j", async (patch) => {
    grants.findById.mockResolvedValue({ ...grant(), ...patch });
    await expect(boundary().authorize("token", "get_current_user")).rejects.toMatchObject({ code: "NAO_AUTENTICADO" });
  });

  it.each([{ deletedAt: new Date() }, { tokenVersion: 4 }, { orgId: "another" }, { id: "another" }])("rechecks current account state %j", async (patch) => {
    users.findById.mockResolvedValue({ ...user(), ...patch });
    await expect(boundary().authorize("token", "get_current_user")).rejects.toMatchObject({ code: "NAO_AUTENTICADO" });
  });

  it("blocks required password change", async () => {
    users.findById.mockResolvedValue({ ...user(), mustChangePassword: true });
    await expect(boundary().authorize("token", "get_current_user")).rejects.toMatchObject({ code: "TROCA_SENHA_OBRIGATORIA" });
  });

  it.each(["token", "grant"])("requires the tool scope in %s", async (where) => {
    if (where === "token") verifier.verifyAccessToken.mockResolvedValue({ ...claims(), scopes: ["tasks:read"] });
    else grants.findById.mockResolvedValue({ ...grant(), scopes: ["tasks:read"] });
    await expect(boundary().authorize("token", "update_task", "project")).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("scope cannot restore a revoked user permission", async () => {
    users.findById.mockResolvedValue({ ...user(), rolePermissions: [] });
    await expect(boundary().authorize("token", "update_task", "project")).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("rechecks connection and user on every operation", async () => {
    const auth = boundary();
    await auth.authorize("token", "get_task", "project");
    grants.findById.mockResolvedValue({ ...grant(), revokedAt: new Date() });
    await expect(auth.authorize("token", "get_task", "project")).rejects.toMatchObject({ code: "NAO_AUTENTICADO" });
    expect(grants.findById).toHaveBeenCalledTimes(2);
  });

  it("requires canonical project ownership even with access-all permission", async () => {
    users.findById.mockResolvedValue({ ...user(), extraPermissions: [PERMISSIONS.projetos_acessar_todos] });
    projects.findById.mockResolvedValue({ id: "project", orgId: "other", deletedAt: null });
    await expect(boundary().authorize("token", "get_task", "project")).rejects.toMatchObject({ code: "NAO_ENCONTRADO" });
  });

  it("denies project reads after membership revocation", async () => {
    access.isMember.mockResolvedValue(false);
    await expect(boundary().authorize("token", "get_task", "project")).rejects.toMatchObject({ code: "NAO_ENCONTRADO" });
  });

  it("requires a project for all scoped tools, including access-all users", async () => {
    users.findById.mockResolvedValue({ ...user(), extraPermissions: [PERMISSIONS.projetos_acessar_todos] });
    await expect(boundary().authorize("token", "update_task")).rejects.toMatchObject({ code: "VALIDACAO" });
  });

  it.each(["delete_task", "waive_finding", "unknown_tool"])("rejects unsupported or privileged tool %s", async (tool) => {
    await expect(boundary().authorize("token", tool, "project")).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("does not mask storage outages as successful authentication", async () => {
    const error = new Error("store unavailable");
    grants.findById.mockRejectedValue(error);
    await expect(boundary().authorize("token", "get_current_user")).rejects.toBe(error);
  });
});
