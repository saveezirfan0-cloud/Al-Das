"use client";

import { Checkbox } from "@/components/ui/checkbox";

export type MenuChoiceOption = { href: string; label: string; group: string | null };

/**
 * Tick boxes for the menu entries (Settings, Menu; the invite and Menu access dialogs). Ticked = shown. Entries in
 * `lockedHidden` are hidden for the whole workspace and cannot be turned on here. Groups follow the order given.
 */
export function MenuChoices({
  choices,
  hidden,
  onChange,
  lockedHidden = [],
  idPrefix,
}: {
  choices: readonly MenuChoiceOption[];
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
  lockedHidden?: readonly string[];
  idPrefix: string;
}) {
  const groups: Array<{ name: string; items: MenuChoiceOption[] }> = [];
  for (const c of choices) {
    const name = c.group ?? "Other";
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, items: [] };
      groups.push(g);
    }
    g.items.push(c);
  }

  function toggle(href: string, shown: boolean) {
    onChange(shown ? hidden.filter((h) => h !== href) : [...hidden, href]);
  }

  if (choices.length === 0)
    return (
      <p className="text-muted-foreground text-sm">This role has no menu entries to choose.</p>
    );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {groups.map((g) => (
        <fieldset key={g.name} className="flex flex-col gap-2">
          <legend className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
            {g.name}
          </legend>
          {g.items.map((c) => {
            const locked = lockedHidden.includes(c.href);
            const id = `${idPrefix}-${c.href.replace(/[^a-z0-9]+/gi, "-")}`;
            return (
              <label
                key={c.href}
                htmlFor={id}
                className="flex items-center gap-2 text-sm has-[button:disabled]:opacity-60"
              >
                <Checkbox
                  id={id}
                  checked={!locked && !hidden.includes(c.href)}
                  disabled={locked}
                  onCheckedChange={(v) => toggle(c.href, v === true)}
                />
                {c.label}
                {locked && (
                  <span className="text-muted-foreground text-xs">(hidden for everyone)</span>
                )}
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
