/** Fonte única da convenção do "Projeto geral" (id determinístico gen-<clienteId>). [migração 006] */
export function generalEngagementId(projectId: string): string {
  return `gen-${projectId}`;
}

export function isGeneralEngagement(engagementId: string, projectId: string): boolean {
  return engagementId === generalEngagementId(projectId);
}
