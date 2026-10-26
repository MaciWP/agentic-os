// A person's initials: the first letter of the first and the last word, whole characters only.
export const initials = (name: string) => {
  const words = name.split(/[\s-]+/).filter(Boolean);
  const first = (w: string | undefined) => (w ? ([...w][0]?.toUpperCase() ?? "") : "");
  return `${first(words[0])}${words.length > 1 ? first(words.at(-1)) : ""}`;
};

export function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--hover)] text-[9px] font-semibold text-ink-2"
    >
      {initials(name)}
    </span>
  );
}
