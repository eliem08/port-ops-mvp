// Contract validation tests — the unified platform's Zod schemas.
import { describe, it, expect } from "vitest";
import {
  AppointmentStatus,
  STATUS_TRANSITIONS,
  CreateAppointmentInput,
  SubmitScanInput,
  DemoRole,
  CreatePlanInput,
  SolverChoice,
  AuditAction,
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

describe("BerthWise planning contracts", () => {
  const vessel = {
    name: "SYN Altair",
    lengthM: 280,
    draftM: 12,
    eta: "2026-10-20T06:00:00Z",
    etd: "2026-10-20T16:00:00Z",
    grainCapable: false,
  };
  const berth = {
    name: "SYN Quay A",
    lengthM: 350,
    maxDraftM: 15,
    grainCapable: true,
  };
  const valid = {
    scenarioName: "SYNTHETIC — test",
    vessels: [vessel],
    berths: [berth],
    solver: "exact",
  };

  it("accepts a valid plan input and defaults the seed", () => {
    const r = CreatePlanInput.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.seed).toBe(42);
  });

  it("rejects empty vessels and empty berths", () => {
    expect(CreatePlanInput.safeParse({ ...valid, vessels: [] }).success).toBe(false);
    expect(CreatePlanInput.safeParse({ ...valid, berths: [] }).success).toBe(false);
  });

  it("rejects more than 20 vessels / 10 berths", () => {
    const manyVessels = Array.from({ length: 21 }, (_, i) => ({
      ...vessel,
      name: `SYN V${i}`,
    }));
    expect(
      CreatePlanInput.safeParse({ ...valid, vessels: manyVessels }).success
    ).toBe(false);
    const manyBerths = Array.from({ length: 11 }, (_, i) => ({
      ...berth,
      name: `SYN Q${i}`,
    }));
    expect(CreatePlanInput.safeParse({ ...valid, berths: manyBerths }).success).toBe(
      false
    );
  });

  it("rejects bad datetimes (non-UTC, invalid calendar, etd before eta)", () => {
    expect(
      CreatePlanInput.safeParse({
        ...valid,
        vessels: [{ ...vessel, eta: "2026-10-20 06:00:00" }],
      }).success
    ).toBe(false);
    expect(
      CreatePlanInput.safeParse({
        ...valid,
        vessels: [{ ...vessel, eta: "2026-13-40T99:00:00Z" }],
      }).success
    ).toBe(false);
    expect(
      CreatePlanInput.safeParse({
        ...valid,
        vessels: [{ ...vessel, etd: "2026-10-20T05:00:00Z" }],
      }).success
    ).toBe(false);
  });

  it("rejects unknown solvers — alns is never a choice", () => {
    expect(CreatePlanInput.safeParse({ ...valid, solver: "alns" }).success).toBe(false);
    expect(CreatePlanInput.safeParse({ ...valid, solver: "nope" }).success).toBe(false);
    expect(SolverChoice.options).toEqual([
      "exact",
      "greedy",
      "annealing",
      "tabu",
      "genetic",
    ]);
  });

  it("rejects unknown fields (strict)", () => {
    expect(CreatePlanInput.safeParse({ ...valid, hackerField: 1 }).success).toBe(false);
  });

  it("rejects non-positive dimensions", () => {
    expect(
      CreatePlanInput.safeParse({
        ...valid,
        vessels: [{ ...vessel, lengthM: 0 }],
      }).success
    ).toBe(false);
    expect(
      CreatePlanInput.safeParse({
        ...valid,
        berths: [{ ...berth, maxDraftM: -1 }],
      }).success
    ).toBe(false);
  });

  it("adds the planning.run_created audit action", () => {
    expect(AuditAction.options).toContain("planning.run_created");
  });
});
