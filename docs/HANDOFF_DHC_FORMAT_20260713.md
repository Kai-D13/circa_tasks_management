# Handoff - Urgent DHC format fix (2026-07-13)

## Context

Stakeholder reported that the Prescription module (`/prescriptions`) still enforced the old DHC sequence prefix `DHC00...`, while real POS order codes have moved to `DHC01...`.

This caused staff to be blocked when submitting or correcting valid new DHC codes.

## Scope

Only the DHC format constraint was changed. No UI workflow, search logic, sync logic, RLS, FS module, or other prescription behavior was touched.

## File changed

- `webapp/lib/prescriptions/constants.ts`

## What changed

Before:

```ts
export const DHC_STRICT_PATTERN = /^DHC00\d{6}$/
export const DHC_FORMAT_HINT = 'Mã DHC gồm DHC00 + 6 chữ số, ví dụ DHC0097848'
```

After:

```ts
export const DHC_STRICT_PATTERN = /^DHC\d{6,12}$/
export const DHC_FORMAT_HINT = 'Mã DHC bắt đầu bằng DHC và theo sau là 6-12 chữ số, ví dụ DHC0097848 hoặc DHC01012345'
```

## Why this is safe

`DHC_STRICT_PATTERN` is the shared constant used by:

- `PrescriptionForm.tsx` client-side validation for new prescription submissions.
- `OrderCodeFixForm.tsx` client-side validation for DHC correction.
- `app/actions/prescriptions.ts` server-side validation for submit/correct actions.

So the fix applies consistently to both new submit and DHC correction without changing any component flow.

The looser legacy `DHC_PATTERN = /^DHC\d+$/` was not changed because it is used for existing sync/import paths and should remain backward-compatible.

## Accepted examples

- `DHC0097848`
- `DHC00878115`
- `DHC01012345`

## Rejected examples

- `DHC00`
- `DHCABC123`
- `ABC01012345`
- `DHC01A2345`

## Verification run

```bash
node -e "const r=/^DHC\d{6,12}$/; const ok=['DHC0097848','DHC00878115','DHC01012345']; const bad=['DHC00','DHCABC123','ABC01012345','DHC01A2345']; console.log({ok: ok.map(x=>[x,r.test(x)]), bad: bad.map(x=>[x,r.test(x)])})"

cd webapp
npx tsc --noEmit
```

Result: both passed.

## QA checklist

1. Staff submits a new prescription with a valid `DHC01...` code -> allowed.
2. Staff/super fixes an errored DHC to a valid `DHC01...` code -> allowed.
3. Invalid values such as `DHCABC123` or `ABC01012345` -> still blocked.
4. Existing `DHC00...` codes -> still allowed.

## Migration

No database migration needed.