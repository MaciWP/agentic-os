import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore, useStore } from "./store.ts";

describe("createStore", () => {
  test("set and update change the value and tell each listener once per change", () => {
    const store = createStore(1);
    const seen: number[] = [];
    const off = store.subscribe(() => seen.push(store.get()));
    store.set(2);
    store.set(2);
    store.update((n) => n + 1);
    expect(store.get()).toBe(3);
    expect(seen).toEqual([2, 3]);
    off();
    store.set(4);
    expect(seen).toEqual([2, 3]);
  });

  test("useStore renders the current value, also when rendered to a string", () => {
    const store = createStore("a");
    const View = () => createElement("b", null, useStore(store));
    store.set("now");
    expect(renderToStaticMarkup(createElement(View))).toBe("<b>now</b>");
  });
});
