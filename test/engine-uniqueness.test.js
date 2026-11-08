/**
 * G1.2 — engine uniqueness.
 *
 * The bundle patch disables `compaction-basic`, but a patch is not a guarantee:
 * a profile that re-enables the row, or a hand-written patch that forgets the
 * disable, would mount two engines. `composeEntries` does NOT reject that — it
 * is a pure entry-merge and happily returns two active rows (verified: removing
 * the disable from cordis.patch.yml yields
 * compaction-basic=@deepseek-ai/dsh-compaction-basic AND compaction-lcm=dsh-lcm,
 * with no error).
 *
 * What actually prevents double compaction is Cordis itself: `ctx.compaction` is
 * a Service, and a second registration on the same context throws
 * `service "compaction" has been registered`. This test pins that, because it is
 * the only thing standing between a mis-edited patch and two summarizers racing
 * on the same session.
 *
 * Skips where the packages are not installed (outside a dsh profile).
 */
import assert from "node:assert/strict";
import test from "node:test";

test("a second compaction engine on one context is rejected", async (t) => {
  let cordis;
  let compaction;
  try {
    cordis = await import("@deepseek-ai/cordis");
    compaction = await import("@deepseek-ai/dsh-compaction");
  } catch {
    t.skip("@deepseek-ai/cordis and dsh-compaction are only resolvable inside a dsh profile");
    return;
  }

  const { Context } = cordis;
  const { CompactionEngine } = compaction;
  assert.equal(typeof CompactionEngine, "function", "CompactionEngine must be constructible");

  const ctx = new Context();
  class First extends CompactionEngine {}
  class Second extends CompactionEngine {}

  new First(ctx);
  // Cordis wraps the registered service in a proxy, so identity is not
  // comparable; what matters is that the seam is occupied and which class serves it.
  assert.ok(ctx.compaction instanceof First, "the first engine must own ctx.compaction");

  assert.throws(
    () => new Second(ctx),
    /service "compaction" has been registered/i,
    "a second engine must be refused, or two summarizers would compact the same session"
  );
});
