"""Refreshes the generated part of docs/TODO_FOR_AL_DAS.md (between the markers) from the open-questions register
(docs/audit/open-questions.md, the source of truth) and the data requests in docs/20_FINANCE_CONTROL_PLAN.md.

Usage: python3 scripts/compile-todo.py   (run from the repo root after editing the register)
"""
import datetime
import re

TODO = "docs/TODO_FOR_AL_DAS.md"
START, END = "<!-- generated:start -->", "<!-- generated:end -->"
FIRST = ["OQ-122", "OQ-120", "OQ-117", "OQ-101", "OQ-26", "OQ-104", "OQ-05", "OQ-06", "OQ-90", "OQ-121", "OQ-115", "OQ-123", "OQ-136"]
GROUPS = [
    ("Clinical (Abdul, Snezana, clinical lead)", ["abdul", "snezana", "clinical lead", "medical director"]),
    ("Finance, insurance and accounting", ["hardik", "krishna", "saeed", "mohammed", "vineetha", "sharaf", "althaf", "ceo", "merry", "finance"]),
    ("Marketing, consent and legal", ["marketing", "legal", "data-protection"]),
    ("Management, operations and IT", ["management", "operations", "it", "clinic"]),
    ("Build team and vendors (Saveez, Unite)", ["saveez", "unite", "off"]),
]


def clean(t: str) -> str:
    t = re.sub(r"`([^`]*)`", lambda m: "" if re.search(r"/|\.(ts|tsx|sql|md|json)\b", m.group(1)) else m.group(1), t)
    return re.sub(r"\s{2,}", " ", re.sub(r"\(\s*[,;]?\s*\)", "", t)).strip()


def load():
    out = []
    for line in open("docs/audit/open-questions.md", encoding="utf-8"):
        if not line.startswith("| OQ-"):
            continue
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        if len(cells) >= 8:
            q, today, prop, owner, blocking = cells[1], cells[3], cells[4], cells[5], cells[6]
        else:
            q = cells[1]
            m = re.search(r"Owner:\s*([^.]+)", q)
            owner, today, prop = (m.group(1) if m else "Saveez"), "", ""
            blocking = "Yes" if re.search(r"\bblocking\b", q, re.I) else "No"
        if re.search(r"\*\*(Resolved|Answered)|Answered 1[0-9] Oct|Answered by|Resolved 1[0-9] Oct", q):
            continue
        out.append(dict(id=cells[0], q=clean(q), today=clean(today), prop=clean(prop), owner=owner,
                        blocking=blocking.lower().startswith("yes") or "**yes" in blocking.lower()))
    return out


def item(x):
    extra = [f"today: {x['today']}" for _ in [0] if x["today"] and x["today"] not in ("n/a", "—", "-")]
    extra += [f"proposed: {x['prop']}" for _ in [0] if x["prop"] and x["prop"] not in ("—", "-")]
    tail = f" _({'; '.join(extra)})_" if extra else ""
    return f"- [ ] **{x['id']}** ({x['owner']}{', blocking' if x['blocking'] else ''}): {x['q']}{tail}"


def generated():
    qs = load()
    by_id = {x["id"]: x for x in qs}
    lines = [f"_Generated {datetime.date.today():%d %b %Y} by `scripts/compile-todo.py`: {len(qs)} open questions, "
             f"{sum(x['blocking'] for x in qs)} of them blocking a feature._", "", "### Answer these first", ""]
    lines += [item(by_id[i]) for i in FIRST if i in by_id]
    done = set(FIRST)
    for title, keys in GROUPS:
        sel = [x for x in qs if x["id"] not in done
               and any(re.search(rf"\b{k}", x["owner"].split("/")[0].strip().lower()) for k in keys)]
        if sel:
            done |= {x["id"] for x in sel}
            lines += ["", f"### {title}", ""] + [item(x) for x in sel]
    rest = [x for x in qs if x["id"] not in done]
    if rest:
        lines += ["", "### Other", ""] + [item(x) for x in rest]
    plan = open("docs/20_FINANCE_CONTROL_PLAN.md", encoding="utf-8").read()
    lines += ["", "## 8. Files and samples to send", "", "| # | What | For | From |", "|---|---|---|---|"]
    lines += [l for l in plan.split("\n") if re.match(r"\| D\d+ \|", l)]
    return "\n".join(lines)


doc = open(TODO, encoding="utf-8").read()
i, j = doc.index(START) + len(START), doc.index(END)
open(TODO, "w", encoding="utf-8").write(doc[:i] + "\n" + generated() + "\n" + doc[j:])
print("updated", TODO)
