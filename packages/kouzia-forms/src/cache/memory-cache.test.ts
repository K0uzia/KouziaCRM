import { describe, expect, it } from "vitest";
import { MemoryCache, TTL } from "./memory-cache.js";

describe("MemoryCache", () => {
  it("stocke et restitue une valeur", () => {
    const cache = new MemoryCache();
    cache.set("a", { n: 1 }, TTL.ADRESSE);
    expect(cache.get<{ n: number }>("a")).toEqual({ n: 1 });
  });

  it("expire après le TTL", () => {
    const cache = new MemoryCache();
    cache.set("b", "x", -1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("supprime et vide", () => {
    const cache = new MemoryCache();
    cache.set("c", 1, TTL.COMMUNES);
    cache.delete("c");
    expect(cache.get("c")).toBeUndefined();
    cache.set("d", 2, TTL.COMMUNES);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
