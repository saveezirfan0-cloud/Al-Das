export const LABEL_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const LABEL_COLOR_CLASSES: Record<LabelColor, string> = {
  gray: "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-100",
  red: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-100",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-100",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-100",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-100",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-100",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-100",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-100",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-900/60 dark:text-pink-100",
};

export function labelClass(color: string | null | undefined): string {
  return LABEL_COLOR_CLASSES[(color as LabelColor) ?? "gray"] ?? LABEL_COLOR_CLASSES.gray;
}
