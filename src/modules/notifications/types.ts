// Notificações de "tarefa atribuída a você". Não há tabela própria: derivamos da task_activity
// (eventos ASSIGNEE_ADDED / PRIMARY_CHANGED já gravados com ator + alvo). [notificações]

export interface NotificationRow {
  id: string; // id do evento de atividade — chave estável do "visto" no client
  taskId: string;
  title: string; // título da tarefa (para o item e o deep-link)
  actorName: string; // quem atribuiu (snapshot no evento)
  type: string; // ASSIGNEE_ADDED | PRIMARY_CHANGED
  createdAt: Date;
}

export interface NotificationRepo {
  /**
   * Eventos de atribuição em que `recipientId` foi o ALVO e OUTRA pessoa atribuiu (actor != recipient —
   * suprime auto-atribuição), dentro do escopo acessível, tarefa não excluída, dedupe por tarefa
   * (o mais recente), a partir de `since`, mais-recente-primeiro.
   */
  listAssignmentsForRecipient(
    orgId: string,
    recipientId: string,
    scope: string[] | "all",
    since: Date,
    limit: number,
  ): Promise<NotificationRow[]>;
}
