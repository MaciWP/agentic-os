import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeltaText, Spark } from "./charts.tsx";

const text = (value: number) =>
  renderToStaticMarkup(<DeltaText d={{ kind: "pct", value }} />)
    .replace(/<[^>]+>/g, "")
    // Intl puts a no-break space before "%".
    .replace(/\u00a0/g, " ");

test("a change reads as a percentage, ten times or more as a factor", () => {
  expect(text(0.34)).toBe("▲ 34 %");
  expect(text(-0.5)).toBe("▼ 50 %");
  expect(text(0.001)).toBe("=");
  expect(text(336.4)).toBe("▲ ×337");
  expect(renderToStaticMarkup(<DeltaText d={{ kind: "new" }} />)).toContain("nuevo");
});

test("a spark breaks at a null instead of dropping to zero", () => {
  const svg = renderToStaticMarkup(<Spark values={[1, null, 2, 3, null]} />);
  expect(svg.match(/<polyline/g)).toHaveLength(1);
  expect(svg.match(/<circle/g)).toHaveLength(1);
  expect(svg).not.toContain(",28 ");
});
