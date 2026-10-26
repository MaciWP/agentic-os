export function Estimate({ points, size }: { points: number | null; size: string | null }) {
  if (points === null && size === null) return null;
  return (
    <span className="pill tabular-nums" title="Tamaño · puntos">
      {[size, points].filter((v) => v !== null).join(" · ")}
    </span>
  );
}
