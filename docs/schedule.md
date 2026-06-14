# Nango Scheduler Architecture

## 1. Purpose & Workflow

- **Core Purpose**: Provide unified management of scheduled triggers for all Agents, workflows, and backend tasks (supporting both one-shot and recurring executions).
- **Execution Mechanism**: Operates as a **single-process, in-memory** scheduler (based on `setTimeout`). It is extremely lightweight and does not rely on external Cron engines or complex middleware like Redis.
- **Trigger Routing**: All scheduled executions converge entirely into the core dispatcher `runner.start({ mode: "async", initiator: "schedule" })`. This ensures that scheduled tasks share the exact same lifecycle, persistence (`entity_run`), and system notifications (EventBus / SSE) as standard asynchronous background tasks.
- **Cron-Free Model**: To make it intuitive for regular users and to support precise calendar stepping, the 5-part Cron expression has been deprecated in favor of a straightforward trigger parameter model:
  `(startAt, intervalValue, intervalUnit, endAt)`
  *Supported Units: `minute`, `hour`, `day`, `week`, `month`.*

## 2. Time Usage & Calculation

Time handling strictly adheres to the principle: **"Store and compute UTC internally, apply timezone at the edge"**.

- **Underlying Baseline**: All internal timing, comparisons (e.g. `getTime()`), and database storage **absolutely use UTC (`timestamptz`)**.
- **Next Fire Inference (`nextFireAt`)**:
  - **Absolute Millisecond Stepping**: For `minute` and `hour` intervals, a fixed millisecond offset is directly added to the current UTC timestamp.
  - **Calendar-Based Anchor Stepping**: For `day`, `week`, and `month` intervals, to prevent accumulation drift, the calculation **always uses the initially set `startAt` as an absolute anchor**:
    `nextFire = addInterval(startAt, steps * value, unit, timezone)`
  - **Drift Prevention Clamping**: In cross-month calculations, if the target month has insufficient days (e.g. adding 1 month to Jan 31), the system proactively clamps to the end of the month (Feb 28/29), instead of relying on the JS engine to incorrectly overflow to the beginning of the next month.

## 3. Timezone Handling & Priority

In the scheduling system, timezones serve solely as **presentation layer and calendar stepping rules**, and never interfere with the absolute timestamp records.

- **Timezone Resolution Priority**:
  1. **Schedule-Level Timezone (Highest / Persistent Snapshot)**:
     Every `schedule` has its own isolated `timezone` field in the database. This is a snapshot of the user's timezone captured at the exact moment the task was created.
     *Purpose*: Guarantees business stability. Even if the user relocates and changes their system timezone later, a task originally set for "9 AM Beijing Time every day" will continue to execute at 9 AM Beijing Time without shifting.
  2. **User Profile-Level Timezone**:
     The `timezone` field in the user table acts as the default timezone source when creating any new tasks.
  3. **Browser-Level Timezone (Lowest / Dynamically Sensed)**:
     If the user enables `timezone_follow_browser`, the frontend silently updates the Profile-level timezone upon each login.

- **Daylight Saving Time (DST) Safety Guarantee**:
  When stepping by days or months, the scheduler uses `Intl.DateTimeFormat` to split the time into safe wall-clock components (DateParts: Year/Month/Day/Hour/Minute/Second) within the specified timezone. After adding the calendar span, during the reassembly back to UTC (`composeDate`), the system utilizes two trial offset calculations (Walks offset twice) to traverse DST transition points. This ensures that the task on that particular day does not deviate from the configured wall-clock time despite the clock springing forward or falling back.
