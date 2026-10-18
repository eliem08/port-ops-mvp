// Contract validation tests — the unified platform's Zod schemas.
import { describe, it, expect } from "vitest";
import {
  AppointmentStatus,
  STATUS_TRANSITIONS,
  CreateAppointmentInput,
  SubmitScanInput,
  DemoRole,
} from "@/contracts";

describe("AppointmentStatus", () => {
  it("uses the TAS six-status contract enum", () => {
    expect(AppointmentStatus.options).toEqual([
      "requested",
      "confirmed",
      "checked-in",
      "completed",
      "cancelled",
      "no-show",
    ]);
  });

  it("enforces legal transitions", () => {
    expect(STATUS_TRANSITIONS["requested"]).toContain("confirmed");
    expect(STATUS_TRANSITIONS["requested"]).not.toContain("completed");
    expect(STATUS_TRANSITIONS["completed"]).toEqual([]);
  });
});

describe("CreateAppointmentInput", () => {
  it("accepts a valid appointment", () => {
    const r = CreateAppointmentInput.safeParse({
      truckPlate: "CAS-1234-A",
      containerNo: "TCLU1234567",
      scheduledAt: "2026-10-18T14:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-UTC datetimes", () => {
    const r = CreateAppointmentInput.safeParse({
      truckPlate: "CAS-1234-A",
      scheduledAt: "2026-10-18 14:00:00", // no Z suffix
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty plate", () => {
    const r = CreateAppointmentInput.safeParse({
      truckPlate: "",
      scheduledAt: "2026-10-18T14:00:00Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const r = CreateAppointmentInput.safeParse({
      truckPlate: "CAS-1234-A",
      scheduledAt: "2026-10-18T14:00:00Z",
      hackerField: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("SubmitScanInput", () => {
  it("accepts a valid scan", () => {
    const r = SubmitScanInput.safeParse({
      appointmentId: "123e4567-e89b-12d3-a456-426614174000",
      plateRead: "CAS-1234-A",
      confidence: 85,
    });
    expect(r.success).toBe(true);
  });

  it("accepts null confidence (handled by routeScan, never auto-accepts)", () => {
    const r = SubmitScanInput.safeParse({
      appointmentId: "123e4567-e89b-12d3-a456-426614174000",
      confidence: null,
    });
    expect(r.success).toBe(true);
  });
});

describe("DemoRole", () => {
  it("has the five platform roles", () => {
    expect(DemoRole.options).toEqual([
      "operations_viewer",
      "operations_operator",
      "planner",
      "supervisor",
      "administrator",
    ]);
  });
});
