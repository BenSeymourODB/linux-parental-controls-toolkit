/**
 * Component test for the reusable `RecurrenceFields` picker (#361).
 *
 * Covers the presentational contract — inputs reflect the bound model, the
 * end-of-day sentinel renders as 00:00, `disabled` disables the group, and the
 * `error` prop surfaces as an alert. The write path (toggling a day / typing a
 * time updates the *submitted* payload through real `bind:`) is exercised
 * end-to-end in the view authoring suites, which assert the resulting API call.
 */
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import RecurrenceFields from "../../src/lib/components/RecurrenceFields.svelte";
import { MINUTES_PER_DAY } from "../../src/lib/recurrence.js";

/** Render with a full, always-on default prop set; override at will. */
function renderFields(overrides: Record<string, unknown> = {}) {
  return render(RecurrenceFields, {
    idPrefix: "test",
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  });
}

describe("RecurrenceFields presentation", () => {
  it("renders seven weekday checkboxes with full-name accessible labels", () => {
    renderFields();
    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]) {
      expect(screen.getByLabelText(day)).toBeInTheDocument();
    }
  });

  it("checks exactly the weekdays set in the mask (Mon–Fri)", () => {
    renderFields({ recurrenceDays: 0b0011111 });
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      expect(screen.getByLabelText(day)).toBeChecked();
    }
    for (const day of ["Saturday", "Sunday"]) {
      expect(screen.getByLabelText(day)).not.toBeChecked();
    }
  });

  it("checks no weekday for the null (every-day) mask", () => {
    renderFields({ recurrenceDays: null });
    for (const day of ["Monday", "Sunday"]) {
      expect(screen.getByLabelText(day)).not.toBeChecked();
    }
  });

  it("reflects the time window in the start/end inputs", () => {
    renderFields({ recurrenceStartMinute: 960, recurrenceEndMinute: 1080 });
    expect(screen.getByLabelText("Start time")).toHaveValue("16:00");
    expect(screen.getByLabelText("End time")).toHaveValue("18:00");
  });

  it("renders the end-of-day sentinel (1440) as 00:00 in the end input", () => {
    renderFields({ recurrenceStartMinute: 1260, recurrenceEndMinute: MINUTES_PER_DAY });
    expect(screen.getByLabelText("Start time")).toHaveValue("21:00");
    expect(screen.getByLabelText("End time")).toHaveValue("00:00");
  });

  it("reflects the effective-date scope in the date inputs", () => {
    // Local-midnight round-trip: an instant authored from a day shows that day.
    const from = new Date(2026, 2, 1).toISOString(); // 2026-03-01 local
    renderFields({ effectiveFrom: from });
    expect(screen.getByLabelText("Active from date")).toHaveValue("2026-03-01");
    expect(screen.getByLabelText("Active until date")).toHaveValue("");
  });

  it("surfaces the error prop as an alert, and none when null", () => {
    const { rerender } = renderFields({ error: "The end time must be after the start time." });
    expect(screen.getByRole("alert")).toHaveTextContent(/end time must be after/i);

    // The alert clears when the error is resolved.
    void rerender({
      idPrefix: "test",
      recurrenceDays: null,
      recurrenceStartMinute: null,
      recurrenceEndMinute: null,
      effectiveFrom: null,
      effectiveTo: null,
      error: null,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the whole group when disabled", () => {
    renderFields({ disabled: true });
    // The <fieldset disabled> disables its descendant controls; toBeDisabled()
    // honours the ancestor-fieldset inheritance the plain `.disabled` prop misses.
    expect(screen.getByLabelText("Monday")).toBeDisabled();
    expect(screen.getByLabelText("Start time")).toBeDisabled();
  });
});
