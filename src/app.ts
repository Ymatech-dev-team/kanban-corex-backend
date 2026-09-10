import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { healthRoutes } from "./routes/health.js";
import { internalPingRoutes } from "./routes/internal-ping.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerSecurity } from "./plugins/security.js";
import { registerInternalAuth } from "./plugins/internal-auth.js";
import { getPrisma } from "./lib/prisma.js";
import { TokenService, type TokenConfig } from "./modules/auth/token.service.js";
import { PasswordService } from "./modules/auth/password.service.js";
import { RefreshService } from "./modules/auth/refresh.service.js";
import { LockoutService } from "./modules/auth/lockout.service.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { makeAuthRoutes } from "./modules/auth/auth.routes.js";
import { PrismaUserRepo, PrismaRefreshRepo, PrismaLockoutStore } from "./modules/auth/prisma-repos.js";
import { makeAuthenticate, type Authenticate } from "./modules/authz/authenticate.js";
import { Authorizer } from "./modules/authz/authorizer.js";
import { PrismaAuthzUserRepo, PrismaAuditRepo } from "./modules/authz/prisma-repos.js";
import { makeMeRoutes } from "./routes/me.js";
import { ProjectService } from "./modules/projects/project.service.js";
import { PrismaProjectRepo, PrismaProjectAccessRepo } from "./modules/projects/prisma-repos.js";
import { makeProjectRoutes } from "./modules/projects/project.routes.js";
import { TaskService } from "./modules/tasks/task.service.js";
import { PrismaTaskRepo, PrismaSubtaskRepo, PrismaActivityRepo, PrismaCommentRepo } from "./modules/tasks/prisma-repos.js";
import { makeTaskRoutes } from "./modules/tasks/task.routes.js";
import { PrismaIdempotencyStore } from "./lib/idempotency-store.js";
import { MemberService } from "./modules/admin/member.service.js";
import { RoleService } from "./modules/admin/role.service.js";
import { PrismaMemberRepo, PrismaRoleRepo } from "./modules/admin/prisma-repos.js";
import { makeAdminRoutes } from "./modules/admin/admin.routes.js";
import { makeAccountRoutes } from "./modules/account/account.routes.js";
import { CostService } from "./modules/cost/cost.service.js";
import { PrismaOrgRepo, PrismaCostRepo } from "./modules/cost/prisma-repos.js";
import { makeCostRoutes } from "./modules/cost/cost.routes.js";
import { EngagementService } from "./modules/engagements/engagement.service.js";
import { PrismaEngagementRepo, PrismaEngagementMemberRepo } from "./modules/engagements/prisma-repos.js";
import { makeEngagementRoutes } from "./modules/engagements/engagement.routes.js";

export interface AppDeps {
  authService?: AuthService;
  tokenService?: TokenService;
  authenticate?: Authenticate;
  authorizer?: Authorizer;
  projectService?: ProjectService;
  taskService?: TaskService;
  memberService?: MemberService;
  roleService?: RoleService;
  costService?: CostService;
  engagementService?: EngagementService;
}

function tokenConfigFromEnv(): TokenConfig {
  // Fail-closed: sem segredo, não sobe (nada de default hardcoded que forja token). [SEC-001]
  const accessSecret = process.env.JWT_ACCESS_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!accessSecret || !refreshSecret) {
    throw new Error("JWT_ACCESS_SECRET e JWT_REFRESH_SECRET são obrigatórios");
  }
  return {
    accessSecret,
    refreshSecret,
    issuer: "sistema-de-tasks",
    audience: "sistema-de-tasks-api",
    accessTtlSec: 15 * 60, // access curto
    refreshTtlSec: 7 * 24 * 3600, // 7d por token
  };
}

function buildProdAuthService(tokens: TokenService): AuthService {
  const db = getPrisma();
  return new AuthService({
    users: new PrismaUserRepo(db),
    tokens,
    passwords: new PasswordService(12),
    refresh: new RefreshService(new PrismaRefreshRepo(db), tokens, {
      refreshTtlSec: 7 * 24 * 3600,
      familyTtlSec: 30 * 24 * 3600, // teto ABSOLUTO > TTL do token [SEC-003]
      graceMs: 10_000,
    }),
    lockout: new LockoutService(new PrismaLockoutStore(db)),
  });
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-internal-signature"]',
        "*.password",
        "*.passwordHash",
        "*.token",
        "*.accessToken",
        "*.refreshToken",
        "*.currentPassword",
        "*.newPassword",
        "*.confirmPassword",
      ],
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);
  registerInternalAuth(app);
  registerSecurity(app);

  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.register(healthRoutes);
  typed.register(internalPingRoutes);

  // Auth/authz só montam com serviço injetado (testes) OU com DATABASE_URL presente (prod).
  // Sem DATABASE_URL, não instancia TokenService (evita exigir segredos em testes de saúde).
  let authService = deps.authService;
  let tokenService = deps.tokenService;
  let authenticate = deps.authenticate;
  let authorizer = deps.authorizer;
  let projectService = deps.projectService;
  let taskService = deps.taskService;
  let memberService = deps.memberService;
  let roleService = deps.roleService;
  let costService = deps.costService;
  let engagementService = deps.engagementService;
  if (process.env.DATABASE_URL) {
    tokenService = tokenService ?? new TokenService(tokenConfigFromEnv());
    const db = getPrisma();
    const accessRepo = new PrismaProjectAccessRepo(db);
    const auditRepo = new PrismaAuditRepo(db);
    const roleRepo = new PrismaRoleRepo(db);
    const engagementMemberRepo = new PrismaEngagementMemberRepo(db);
    authService = authService ?? buildProdAuthService(tokenService);
    authenticate = authenticate ?? makeAuthenticate({ tokens: tokenService, users: new PrismaAuthzUserRepo(db) });
    authorizer = authorizer ?? new Authorizer(accessRepo);
    projectService =
      projectService ?? new ProjectService(new PrismaProjectRepo(db), accessRepo, auditRepo, engagementMemberRepo);
    taskService =
      taskService ??
      new TaskService(
        new PrismaTaskRepo(db),
        new PrismaSubtaskRepo(db),
        accessRepo,
        new PrismaIdempotencyStore(db),
        new PrismaActivityRepo(db),
        new PrismaCommentRepo(db),
      );
    const memberRepo = new PrismaMemberRepo(db);
    memberService =
      memberService ??
      new MemberService(memberRepo, roleRepo, new PasswordService(12), new PrismaRefreshRepo(db), auditRepo);
    roleService = roleService ?? new RoleService(roleRepo, memberRepo, auditRepo);
    costService = costService ?? new CostService(new PrismaOrgRepo(db), new PrismaCostRepo(db));
    engagementService =
      engagementService ?? new EngagementService(new PrismaEngagementRepo(db), engagementMemberRepo, accessRepo);
  }

  if (authService && tokenService) {
    typed.register(makeAuthRoutes(authService, tokenService));
  }
  if (authenticate) {
    typed.register(makeMeRoutes(authenticate));
  }
  if (authenticate && authService && memberService) {
    typed.register(makeAccountRoutes(authenticate, authService, memberService));
  }
  if (authenticate && authorizer && projectService) {
    typed.register(makeProjectRoutes(authenticate, authorizer, projectService));
  }
  if (authenticate && authorizer && taskService) {
    typed.register(makeTaskRoutes(authenticate, authorizer, taskService));
  }
  if (authenticate && authorizer && memberService && roleService) {
    typed.register(makeAdminRoutes(authenticate, authorizer, memberService, roleService));
  }
  if (authenticate && authorizer && costService) {
    typed.register(makeCostRoutes(authenticate, authorizer, costService));
  }
  if (authenticate && authorizer && engagementService && taskService && costService) {
    typed.register(makeEngagementRoutes(authenticate, authorizer, engagementService, taskService, costService));
  }

  return app;
}
