/** Recurring-trigger schedule builder <-> cron. Daily / weekly / monthly with a time; anything else is "custom". */
import { isValidCron } from "@/lib/cron";

export type ScheduleForm =
  | { freq: "daily"; time: string }
  | { freq: "weekly"; time: string; weekday: number } // 0 = Sunday
  | { freq: "monthly"; time: string; day: number } // 1..28 (29–31 would skip months)
  | { freq: "custom"; cron: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function cronFromForm(f: ScheduleForm): string | null {
  if (f.freq === "custom") return isValidCron(f.cron) ? f.cron.trim() : null;
  const m = TIME.exec(f.time);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (f.freq === "daily") return `${min} ${h} * * *`;
  if (f.freq === "weekly")
    return f.weekday >= 0 && f.weekday <= 6 ? `${min} ${h} * * ${f.weekday}` : null;
  return f.day >= 1 && f.day <= 28 ? `${min} ${h} ${f.day} * *` : null;
}

export function formFromCron(cron: string | undefined): ScheduleForm {
  const c = (cron ?? "").trim();
  const m = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|\d)$/.exec(c);
  if (m && isValidCron(c)) {
    const time = `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
    if (m[3] === "*" && m[4] === "*") return { freq: "daily", time };
    if (m[3] === "*" && m[4] !== "*") return { freq: "weekly", time, weekday: Number(m[4]) };
    if (m[3] !== "*" && m[4] === "*" && Number(m[3]) <= 28)
      return { freq: "monthly", time, day: Number(m[3]) };
  }
  return c ? { freq: "custom", cron: c } : { freq: "daily", time: "09:00" };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeSchedule(f: ScheduleForm): string {
  if (f.freq === "daily") return `Every day at ${f.time}`;
  if (f.freq === "weekly") return `Every ${DAYS[f.weekday]} at ${f.time}`;
  if (f.freq === "monthly") return `On day ${f.day} of every month at ${f.time}`;
  return `Custom schedule (${f.cron})`;
}
