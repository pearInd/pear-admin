/* lib/size-hesitation.js - what counts as a hesitation, which size is "final". */
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSizeHesitation, sortSizes } from "../lib/size-hesitation.js";

const ev = (t, type, sid, g, size, from, rec) => ({
  created_at: `2026-11-25T10:00:${String(t).padStart(2, "0")}Z`,
  event_type: type, session_id: sid, garment_id: g, garment_name: "tee " + g,
  size, from_size: from, rec_size: rec,
});

test("sizes sort on the letter scale, then numbers", () => {
  assert.deepEqual(sortSizes(["XL", "S", "M", "XS"]), ["XS", "S", "M", "XL"]);
  assert.deepEqual(sortSizes(["34", "30", "32"]), ["30", "32", "34"]);
  assert.deepEqual(sortSizes(["2XL", "L"]), ["L", "2XL"]);
});

test("M -> S -> M then cart M: one hesitation S/M, final M from the cart", () => {
  const s = summarizeSizeHesitation([
    ev(1, "size_pick", "a", "1", "S", "M", "M"),
    ev(2, "size_pick", "a", "1", "M", "S", "M"),
    ev(3, "cart_add", "a", "1", "M"),
  ]);
  assert.equal(s.hesitations, 1);
  assert.equal(s.ranges[0].range, "S / M");
  assert.deepEqual(s.recent[0].sizes, ["S", "M"]);
  assert.equal(s.recent[0].final, "M");
  assert.equal(s.recent[0].finalSource, "cart");
  assert.equal(s.endedInCart, 1);
  assert.equal(s.finalIsRecommended, 1);
  assert.equal(s.recent[0].switches, 2);
});

test("no cart: the final size is the last one switched to", () => {
  const s = summarizeSizeHesitation([
    ev(1, "size_pick", "b", "1", "L", "M", "M"),
    ev(2, "size_pick", "b", "1", "XL", "L", "M"),
  ]);
  assert.equal(s.recent[0].final, "XL");
  assert.equal(s.recent[0].finalSource, "last");
  assert.equal(s.recent[0].range, "M / L / XL");
  assert.equal(s.avgSizesConsidered, 3);
  assert.equal(s.finalIsRecommended, 0);
});

test("a cart add without any switch is not a hesitation; garments and sessions stay apart", () => {
  const s = summarizeSizeHesitation([
    ev(1, "cart_add", "c", "1", "M"),
    ev(2, "size_pick", "d", "1", "S", "M", "M"),
    ev(3, "size_pick", "d", "2", "L", "M", "M"),
    ev(4, "cart_add", "d", "2", "L"),
  ]);
  assert.equal(s.hesitations, 2);
  assert.equal(s.sessions, 1);
  const byRange = Object.fromEntries(s.ranges.map((r) => [r.range, r]));
  assert.equal(byRange["S / M"].count, 1);
  assert.equal(byRange["M / L"].cart, 1);
  assert.deepEqual(byRange["M / L"].finals, [{ size: "L", count: 1 }]);
});

test("empty input", () => {
  const s = summarizeSizeHesitation([]);
  assert.equal(s.hesitations, 0);
  assert.equal(s.avgSizesConsidered, null);
  assert.deepEqual(s.ranges, []);
});
