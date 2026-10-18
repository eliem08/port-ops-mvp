// Security regression tests: GateWatch fail-open holes must stay closed.
// These lock in the two fixes from the hardening mission:
//  1. NaN-confidence OCR payload silently auto-accepted (NaN < 70 is false)
//  2. Confidence 101 auto-accepted (>100 never clamped)
import { describe, it, expect } from "vitest";
import { routeScan, needsReview, DEFAULT_REVIEW_THRESHOLD } from "@/vendored/gatewatch/review";

describe("routeScan fail-closed guarantees", () => {
  const T = DEFAULT_REVIEW_THRESHOLD; // 70

  it("NaN confidence NEVER auto-accepts", () => {
    expect(routeScan({ error: null, confidence: NaN }, T)).not.toBe("auto-accept");
    expect(needsReview(NaN, T)).toBe(true);
  });

  it("Infinity confidence NEVER auto-accepts", () => {
    expect(routeScan({ error: null, confidence: Infinity }, T)).not.toBe("auto-accept");
    expect(needsReview(Infinity, T)).toBe(true);
  });

  it("confidence 101 NEVER auto-accepts (out-of-range)", () => {
    expect(routeScan({ error: null, confidence: 101 }, T)).not.toBe("auto-accept");
    expect(needsReview(101, T)).toBe(true);
  });

  it("negative confidence NEVER auto-accepts", () => {
    expect(routeScan({ error: null, confidence: -5 }, T)).not.toBe("auto-accept");
    expect(needsReview(-5, T)).toBe(true);
  });

  it("below-threshold confidence goes to human review", () => {
    expect(routeScan({ error: null, confidence: 69.9 }, T)).toBe("human-review");
  });

  it("scan error always fails closed", () => {
    expect(routeScan({ error: "ocr failed", confidence: 99 }, T)).toBe("scan-failed");
  });

  it("at-threshold confidence auto-accepts (boundary)", () => {
    expect(routeScan({ error: null, confidence: 70 }, T)).toBe("auto-accept");
  });

  it("high valid confidence auto-accepts", () => {
    expect(routeScan({ error: null, confidence: 95 }, T)).toBe("auto-accept");
  });
});
