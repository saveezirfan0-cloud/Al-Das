import { runReportEmails } from "@/lib/finance/report-emails-server";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/finance_report_emails (pg_cron every 10 minutes): the scheduled daily flash and monthly summary e-mails
 * (Phase G). Works out what is due in each organisation's timezone, claims each (schedule, period) once in SQL and queues
 * one e-mail per recipient who may receive it now (lib/finance/report-emails.ts). Training workspaces send nothing.
 * Counts only are logged.
 */
registerTask("finance_report_emails", {
  name: "finance.report_emails",
  async run(admin, log) {
    const totals = await runReportEmails(admin);
    log.info("finance report e-mails", totals);
    return totals;
  },
});
