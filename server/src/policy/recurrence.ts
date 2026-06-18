/**
 * Recurrence + date-scoping value bounds and validators, shared between the
 * policy schema's `CHECK` constraints (see {@link ./schema.ts}) and the
 * `/api/*` zod DTOs (#51/#148) — the same single-source idiom as
 * {@link ./enums.ts}, so the storage constraint and the request validation can
 * never drift apart.
 *
 * The model is fixed in `docs/adr/0005-recurrence-and-date-scoping.md`
 * ("Reserved schema shape"); these columns are *reserved* by #146 ahead of the
 * resolver (#143, Phase 4) and the editors (#53/#63) that give them behaviour.
 * Nothing here resolves "is this rule active at instant *T*?" — that is the
 * resolver's job.
 *
 * A schedule's recurrence is a purpose-built day-of-week + intra-day window:
 *
 * - **`recurrenceDays`** — a 7-bit ISO-8601 weekday mask (bit 0 = Monday …
 *   bit 6 = Sunday), so a set value is in `[1, 127]`; `null` = no weekday
 *   restriction.
 * - **`recurrenceStartMinute` / `recurrenceEndMinute`** — minutes from local
 *   midnight, active on the half-open interval `[start, end)`; both `null` =
 *   no intra-day restriction. When set, `0 <= start < end <= 1440`.
 * - **`effectiveFrom` / `effectiveTo`** — UTC instants that date-scope the
 *   rule; `null` means open-ended on that side.
 *
 * The degenerate row (every field `null`) is **always-on** — identical to the
 * pre-recurrence uniform rule, which is what keeps the column reservation
 * non-breaking for the Phase-2 CRUD and the precedence resolver.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

/** Smallest valid weekday mask: exactly one ISO weekday set. */
export const WEEKDAY_MASK_MIN = 1;
/** Largest valid weekday mask: all seven ISO weekdays set (`0b1111111`). */
export const WEEKDAY_MASK_MAX = 127;

/** Earliest local minute-of-day a window may reference (00:00). */
export const MINUTE_OF_DAY_MIN = 0;
/** Latest local minute-of-day a window may reference (24:00, the exclusive end). */
export const MINUTE_OF_DAY_MAX = 1440;

/**
 * A 7-bit ISO-weekday mask (`1..127`). Bit *i* set ⇒ active on ISO weekday
 * *i + 1* (bit 0 = Monday, bit 6 = Sunday), per ADR 0005 §1.
 */
export const weekdayMaskSchema = z.number().int().min(WEEKDAY_MASK_MIN).max(WEEKDAY_MASK_MAX);

/** A minute-of-day in `[0, 1440]`; the `start < end` ordering is enforced on the pair. */
export const minuteOfDaySchema = z.number().int().min(MINUTE_OF_DAY_MIN).max(MINUTE_OF_DAY_MAX);

/**
 * An effective-window bound on the wire: an ISO-8601 UTC instant. Storage is
 * epoch seconds (ADR 0001 → "UTC everywhere internally"); the DTO presents the
 * unambiguous string form, matching every other timestamp in `api/policy`.
 */
export const effectiveInstantSchema = z.string().datetime();

/**
 * The reserved recurrence + date-scoping fields as they appear on a schedule
 * create request — a building block #51/#148 compose into the full schedule
 * DTO. Every field is optional and defaults to `null` (the always-on
 * degenerate), so a caller that sends none gets a uniform, always-active rule.
 *
 * The cross-field invariants mirror the schema's `CHECK` constraints exactly:
 *
 * - the two minute bounds are **both** present or **both** absent;
 * - when present, `start < end`;
 * - when both effective bounds are present, `effectiveFrom < effectiveTo`.
 */
export const scheduleRecurrenceSchema = z
  .object({
    recurrenceDays: weekdayMaskSchema.nullable().default(null),
    recurrenceStartMinute: minuteOfDaySchema.nullable().default(null),
    recurrenceEndMinute: minuteOfDaySchema.nullable().default(null),
    effectiveFrom: effectiveInstantSchema.nullable().default(null),
    effectiveTo: effectiveInstantSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const startSet = value.recurrenceStartMinute !== null;
    const endSet = value.recurrenceEndMinute !== null;

    if (startSet !== endSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recurrenceStartMinute and recurrenceEndMinute must be set together",
        path: [endSet ? "recurrenceStartMinute" : "recurrenceEndMinute"],
      });
    } else if (
      value.recurrenceStartMinute !== null &&
      value.recurrenceEndMinute !== null &&
      value.recurrenceStartMinute >= value.recurrenceEndMinute
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recurrenceEndMinute must be greater than recurrenceStartMinute",
        path: ["recurrenceEndMinute"],
      });
    }

    if (
      value.effectiveFrom !== null &&
      value.effectiveTo !== null &&
      Date.parse(value.effectiveFrom) >= Date.parse(value.effectiveTo)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "effectiveTo must be after effectiveFrom",
        path: ["effectiveTo"],
      });
    }
  });

/** The parsed shape of {@link scheduleRecurrenceSchema} (every field resolved to a value). */
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;
