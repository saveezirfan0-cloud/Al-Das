/**
 * Step 1: pipelines, stages, enquiry custom fields and enquiry sources from sanoflow-config.json.
 * Idempotent: pipelines and stages are keyed in external_refs by their Sanoflow name; an existing
 * Pulse pipeline or stage with the same name is adopted, never duplicated. Nothing is deleted or
 * renamed: a stage removed from the config stays in Pulse.
 */
import type { SanoflowConfig } from "./config";
import { ENQUIRY_LIST_MAX, type EnquiryListKey } from "./ports";
import { newRun, warn, type EntityRun, type RunContext } from "./run";
import { nameKey } from "./values";

export const pipelineKey = (p: { name: string; sanoflow_name?: string }) =>
  nameKey(p.sanoflow_name ?? p.name);
export const stageKey = (pipeline: string, s: { name: string; sanoflow_name?: string }) =>
  `${pipeline}::${nameKey(s.sanoflow_name ?? s.name)}`;

export async function runConfig(ctx: RunContext): Promise<EntityRun[]> {
  const { ports, config } = ctx;
  const pipelines = newRun("pipeline", "Pipelines", null);
  const stages = newRun("stage", "Stages", null);
  const fields = newRun("enquiry_field", "Enquiry custom fields", null);
  const sources = newRun("enquiry_source", "Enquiry sources", null);
  const lostReasons = newRun("lost_reason", "Lost / disqualified reasons", null);

  const hasDefault = !!(await ports.findOne("pipelines", { is_default: true }));
  const pipelineCount = await ports.countRows("pipelines");

  for (const [pi, p] of config.pipelines.entries()) {
    pipelines.counters.read++;
    const key = pipelineKey(p);
    let id: string | null = null;
    const ref = await ports.findRef("pipeline", key);
    if (ref && (await ports.getRow("pipelines", ref.localId))) {
      id = ref.localId;
      pipelines.counters.unchanged++;
    } else {
      const existing = await ports.findOne("pipelines", { name: p.name });
      if (existing) {
        id = existing.id;
        pipelines.counters.adopted++;
      } else {
        const res = await ports.insertRow("pipelines", {
          name: p.name,
          sort: pipelineCount + pi,
          is_default: !!p.is_default && !hasDefault,
        });
        if ("error" in res) {
          pipelines.counters.failed++;
          pipelines.problems.push([pi + 1, res.error]);
          continue;
        }
        id = res.id;
        pipelines.counters.created++;
        if (p.is_default && hasDefault) warn(pipelines, "default_kept_existing");
      }
      await ports.upsertRef({
        entity: "pipeline",
        externalId: key,
        localTable: "pipelines",
        localId: id,
      });
    }

    for (const [si, s] of p.stages.entries()) {
      stages.counters.read++;
      const sk = stageKey(key, s);
      const sref = await ports.findRef("stage", sk);
      if (sref && (await ports.getRow("stages", sref.localId))) {
        stages.counters.unchanged++;
        continue;
      }
      const existing = await ports.findOne("stages", { pipeline_id: id, name: s.name });
      let sid: string;
      if (existing) {
        sid = existing.id;
        stages.counters.adopted++;
      } else {
        const res = await ports.insertRow("stages", {
          pipeline_id: id,
          name: s.name,
          sort: si,
          ...(s.color ? { color: s.color } : {}),
        });
        if ("error" in res) {
          stages.counters.failed++;
          stages.problems.push([si + 1, res.error]);
          continue;
        }
        sid = res.id;
        stages.counters.created++;
      }
      await ports.upsertRef({
        entity: "stage",
        externalId: sk,
        localTable: "stages",
        localId: sid,
      });
    }
  }

  const fieldCount = await ports.countRows("custom_fields");
  for (const [fi, f] of config.enquiry_custom_fields.entries()) {
    fields.counters.read++;
    const existing = await ports.findOne("custom_fields", { entity: "enquiry", key: f.key });
    if (existing) {
      if (existing.type !== f.type) warn(fields, "existing_field_has_other_type");
      fields.counters.adopted++;
      continue;
    }
    const res = await ports.insertRow("custom_fields", {
      entity: "enquiry",
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.options?.length ? { options: f.options } : {}),
      sort: fieldCount + fi,
    });
    if ("error" in res) {
      fields.counters.failed++;
      fields.problems.push([fi + 1, res.error]);
    } else fields.counters.created++;
  }

  await mergeEnquiryList(ctx, "sources", config.sources, sources);
  // Pulse offers these when an enquiry is marked lost / disqualified (free text stays allowed).
  const reasons = [...new Set(Object.values(config.lost_reasons).map((r) => r.trim()))];
  await mergeEnquiryList(ctx, "lost_reasons", reasons, lostReasons);
  return [pipelines, stages, fields, sources, lostReasons];
}

/** Adds the values a Settings → Enquiries list does not have yet (case-insensitive), within its cap. */
export async function mergeEnquiryList(
  ctx: RunContext,
  key: EnquiryListKey,
  wanted: readonly string[],
  run: EntityRun,
): Promise<number> {
  if (!wanted.length) return 0;
  const current = await ctx.ports.enquiryList(key);
  const have = new Set(current.map((s) => s.toLowerCase()));
  const add: string[] = [];
  for (const v of wanted) {
    run.counters.read++;
    if (have.has(v.toLowerCase())) run.counters.unchanged++;
    else {
      have.add(v.toLowerCase());
      add.push(v);
    }
  }
  if (!add.length) return 0;
  const next = [...current, ...add].slice(0, ENQUIRY_LIST_MAX[key]);
  const dropped = current.length + add.length - next.length;
  const res = await ctx.ports.setEnquiryList(key, next);
  if (res.error) {
    run.counters.failed += add.length;
    return 0;
  }
  run.counters.created += add.length - dropped;
  run.counters.skipped += dropped;
  if (dropped) warn(run, `${key}_list_full`);
  return add.length - dropped;
}

/** Pulse ids for a Sanoflow pipeline / stage name, through the refs step 1 wrote. */
export class PipelineResolver {
  private cache = new Map<string, string | null>();
  constructor(
    private readonly ctx: RunContext,
    private readonly config: SanoflowConfig = ctx.config,
  ) {}

  private pipelineFor(raw: string) {
    const k = nameKey(raw);
    return this.config.pipelines.find((p) => pipelineKey(p) === k || nameKey(p.name) === k) ?? null;
  }

  async pipeline(raw: string): Promise<string | null> {
    const p = this.pipelineFor(raw);
    if (!p) return null;
    const key = `p:${pipelineKey(p)}`;
    if (!this.cache.has(key)) {
      const ref = await this.ctx.ports.findRef("pipeline", pipelineKey(p));
      this.cache.set(key, ref?.localId ?? null);
    }
    return this.cache.get(key) ?? null;
  }

  async stage(pipelineRaw: string, stageRaw: string): Promise<string | null> {
    const p = this.pipelineFor(pipelineRaw);
    if (!p) return null;
    const k = nameKey(stageRaw);
    const s = p.stages.find(
      (x) => nameKey(x.sanoflow_name ?? x.name) === k || nameKey(x.name) === k,
    );
    if (!s) return null;
    const sk = stageKey(pipelineKey(p), s);
    const key = `s:${sk}`;
    if (!this.cache.has(key)) {
      const ref = await this.ctx.ports.findRef("stage", sk);
      this.cache.set(key, ref?.localId ?? null);
    }
    return this.cache.get(key) ?? null;
  }
}
