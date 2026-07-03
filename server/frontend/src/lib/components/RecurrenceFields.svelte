<!--
  Recurrence + date-scope picker (#361 — the frontend last mile of #140).

  A reusable, presentational editor for a schedule rule's recurrence fields:
  a 7-bit ISO weekday mask, an intra-day time window `[start, end)`, and an
  open-ended effective-date range. Bindable model props carry the canonical
  values (mask / minutes-from-midnight / ISO instants); this component only maps
  them to/from native inputs via the pure helpers in `$lib/recurrence`, so both
  `SchedulesView` and `GroupSchedulesView` (and later the combined Policy view,
  #343) can compose it without re-deriving anything.

  Validation lives in the parent (it owns submit gating) via
  `validateRecurrence`; the resulting message is passed back in as `error` and
  rendered here beside the fields.
-->
<script lang="ts">
  import {
    WEEKDAY_LABELS,
    WEEKDAY_FULL,
    dayChecked,
    toggleDay,
    minutesToTimeInput,
    timeInputToMinutes,
    instantToDateInput,
    dateInputToInstant,
  } from "$lib/recurrence.js";

  let {
    recurrenceDays = $bindable(),
    recurrenceStartMinute = $bindable(),
    recurrenceEndMinute = $bindable(),
    effectiveFrom = $bindable(),
    effectiveTo = $bindable(),
    disabled = false,
    idPrefix,
    error = null,
  }: {
    recurrenceDays: number | null;
    recurrenceStartMinute: number | null;
    recurrenceEndMinute: number | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    disabled?: boolean;
    idPrefix: string;
    error?: string | null;
  } = $props();

  // The DOM event Svelte hands an input's on:change / on:input handler — typing
  // `currentTarget` on the parameter reads the value without an unchecked `as`
  // cast (CLAUDE.md → "no unchecked `as` casts").
  type InputElementEvent = Event & { currentTarget: EventTarget & HTMLInputElement };

  function onDayToggle(index: number, event: InputElementEvent): void {
    recurrenceDays = toggleDay(recurrenceDays, index, event.currentTarget.checked);
  }

  function onStartInput(event: InputElementEvent): void {
    recurrenceStartMinute = timeInputToMinutes(event.currentTarget.value, false);
  }

  function onEndInput(event: InputElementEvent): void {
    recurrenceEndMinute = timeInputToMinutes(event.currentTarget.value, true);
  }

  function onFromInput(event: InputElementEvent): void {
    effectiveFrom = dateInputToInstant(event.currentTarget.value);
  }

  function onToInput(event: InputElementEvent): void {
    effectiveTo = dateInputToInstant(event.currentTarget.value);
  }
</script>

<fieldset class="recurrence" {disabled}>
  <legend>Recurrence</legend>

  <div class="field">
    <span class="label" id="{idPrefix}-days-label">Days</span>
    <div class="days" role="group" aria-labelledby="{idPrefix}-days-label">
      {#each WEEKDAY_LABELS as label, index (label)}
        <label class="day">
          <input
            type="checkbox"
            checked={dayChecked(recurrenceDays, index)}
            onchange={(event) => onDayToggle(index, event)}
            aria-label={WEEKDAY_FULL[index]}
          />
          <span>{label}</span>
        </label>
      {/each}
    </div>
    <p class="hint">No days selected = every day.</p>
  </div>

  <div class="field">
    <span class="label">Time window</span>
    <div class="row">
      <label class="inline">
        <span class="sub">From</span>
        <input
          type="time"
          value={minutesToTimeInput(recurrenceStartMinute)}
          oninput={onStartInput}
          aria-label="Start time"
        />
      </label>
      <label class="inline">
        <span class="sub">To</span>
        <input
          type="time"
          value={minutesToTimeInput(recurrenceEndMinute)}
          oninput={onEndInput}
          aria-label="End time"
        />
      </label>
    </div>
    <p class="hint">Leave both empty = all day. An end of 00:00 means end of day.</p>
  </div>

  <div class="field">
    <span class="label">Active dates</span>
    <div class="row">
      <label class="inline">
        <span class="sub">From</span>
        <input
          type="date"
          value={instantToDateInput(effectiveFrom)}
          oninput={onFromInput}
          aria-label="Active from date"
        />
      </label>
      <label class="inline">
        <span class="sub">Until</span>
        <input
          type="date"
          value={instantToDateInput(effectiveTo)}
          oninput={onToInput}
          aria-label="Active until date"
        />
      </label>
    </div>
    <p class="hint">Leave empty = open-ended.</p>
  </div>

  {#if error !== null}
    <p class="field-error" role="alert">{error}</p>
  {/if}
</fieldset>

<style>
  .recurrence {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.75rem 0.9rem 0.9rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  legend {
    padding: 0 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: #374151;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #374151;
  }
  .days {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }
  .day {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #374151;
  }
  .row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #374151;
  }
  .sub {
    color: #6b7280;
  }
  input[type="time"],
  input[type="date"] {
    padding: 0.4rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
    font: inherit;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  .field-error {
    margin: 0;
    font-size: 0.8rem;
    color: #b91c1c;
  }
  fieldset:disabled {
    opacity: 0.6;
  }
</style>
