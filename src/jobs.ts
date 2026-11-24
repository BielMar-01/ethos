import { periodicJobs } from "./reminders.js";
import { anonymizeOldAudit } from "./security.js";

/** Registro das tarefas periódicas (rodam junto com os lembretes: a cada 6 h no processo ou pelo cron da Vercel). */
periodicJobs.push({ name: "anonimizar auditoria de contas encerradas", run: () => anonymizeOldAudit() });
