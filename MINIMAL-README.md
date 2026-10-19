# GXS QA minimal mockup test

This is a **separate** minimal test; the old suite remains unchanged. DEV only.

## Local setup (PowerShell)

1. Extract the project. Copy your existing private `.env` into the project root (never commit it). Set `GXS_BASE_URL=https://dev.beta.graphxserver.io`, `GXS_EMAIL` and `GXS_PASSWORD`. The repository does **not** include these secrets or `config/auth.json`.
2. Run `pnpm install` and `pnpm run validate`.
3. Run a safe baseline: `pnpm exec playwright test tests/mockup-minimal.spec.ts --headed --workers=1 --retries=0` with `GXS_EXECUTION_MODE=dry-run` set, or `pnpm run test:minimal`.
4. Review `reports/minimal-results.csv` and screenshot `reports/minimal-summary-<id>.png`.
5. Only after deliberately authorizing ONE real creation, run:

```powershell
.\scripts\run-matrix.ps1 -Mode live -MaxRuns 1 -Formats PNG -Sizes 2000
```

This command actually clicks **Generate once**. It stops on failure/uncertainty; do not rerun an uncertain submission before reconciling DEV orders. The live mode requires an intentional invocation of the script. Auth is performed with the project's normal login helper; if an interactive security challenge is required, stop.

## Matrix, AFTER the one-order live test is successfully completed

```powershell
.\scripts\run-matrix.ps1 -Mode live -MaxRuns 32 -ApproveLiveBatch
```

The matrix attempts 4 formats x 8 sizes, sequentially, for the configured SKU in `config/cases.json`; **each iteration is a separate real order**. It stops on the first failure. Choose `-MaxRuns` to reduce the number. Use `-Mode dry-run` to test combinations without submissions.

The results file is `reports/minimal-results.csv`. It contains an append-only event history for each test ID (phase + HTTP status + Order ID + generation status). Do not interpret HTTP 2xx as Completed. If the create response does not expose exactly one recognizable Order ID, the test leaves the attempt as uncertain and **never** clicks Generate again.

## Scope and known limitations

- Square px dimensions only, 2000 through 9000 configurable. PNG/JPG/WEBP/PDF; the UI must actually offer the requested format.
- The format selector, artwork workflow, and dimensions are based on the existing verified Page Object.
- **A real DEV generation has not been executed or verified in this environment.** The test may still hit authentication, TLS, or a server-side 401 issue.
- No fallback that guesses the newest order in a shared organization. Inspect DEV orders manually if an attempt is uncertain.
- JPG download verification assumes the image-size library identifies it as `jpg`. PDF is validated by file signature/page size, not a pixel dimension.
- The script intentionally stops the batch at the first non-Completed result to avoid unsafe repeated live submissions.


## Monitoring and recovery (v2)

### Pre-submission session validation

- Before either mockup test opens the wizard, the dashboard and the exact active organization `Doe Test org-2` must be visible.
- A valid session is reused. An invalid session uses a clean context without saved state and the normal DEV login with `GXS_EMAIL` and `GXS_PASSWORD` from `.env`; verified fresh state replaces `config/auth.json`.
- If Mockup Orders fails to load, one fresh-login recovery is permitted before the wizard. Persistent failure stops with `MOCKUPS_PAGE_LOAD_FAILED`, without attributing the cause to authentication.
- `SESSION_SETUP` and `SESSION_VALIDATION` record login attempts, actual reauthentication and organization verification without credentials or session contents. Mockup tests also attach `session-validation` JSON to the Playwright report.
- Login contexts have no trace or video recording. Interactive MFA/CAPTCHA stops automation; TLS validation remains enabled.
- Session preparation cannot be repeated. After Generate, monitoring validates existing state only and cannot log in again or replace the wizard context.
- The minimal dry-run blocks create-order requests and records `SUBMISSION_SAFETY`. A passing dry-run does not validate live generation.

- A single `testId` occupies a single CSV row; state changes update it atomically.
- The order monitor locates the target order row directly and waits for a terminal status. A missing or closed page results in a bounded retry, not another Generate click.
- Do **not** close the automated Chromium windows while a live test runs. If interrupted after Generate, **do not repeat a live submission**.
- To check an existing ID without Generate: `pnpm run minimal:recover -- MCKP-ORDERID`. This also attempts to download/verify a Completed output. If the download cannot be verified, the CSV records that limitation rather than inventing success.
- The `minimal:recover` command requires the Order ID already be present in the CSV. If there are multiple historical rows with the same test ID, the first recovery consolidates them.
- First validate locally with `pnpm run validate` and a dry-run (`pnpm run test:minimal`). A passing dry-run does not verify live processing.
- The software has **not** been live-tested in this environment.

## V3: controlled QA batch continuation

V3 preserves the same DEV wizard, artwork, authentication, and submission flow. It changes only how confirmed terminal outcomes are reported and how the PowerShell matrix decides whether to continue.

- `Completed` + downloaded output passes format/size verification: `QA_PASS`, continue.
- `Failed` with a confirmed Order ID and successful create request: `QA_FAIL_GENERATION`, continue **without retry**.
- `Completed` with a known Order ID, but output download or validation fails: `QA_FAIL_OUTPUT`, continue and retain the error.
- Missing Order ID, rejected request, navigation failure, runner failure, unknown status, or report ambiguity: **STOP**. Never retry Generate automatically.

Each attempt gets one row in `reports/minimal-results.csv`. A successfully concluded matrix exports `reports/matrix-last-run.csv` (only the most recent batch); keep `minimal-results.csv` as the durable log. The runner does **not** silently skip existing combinations; select the sizes and formats still pending.

**First validate without writes**:

```powershell
pnpm install
pnpm run validate
.\scripts\run-matrix.ps1 -Mode dry-run -MaxRuns 2 -Formats PNG -Sizes 8000,9000
```

**Controlled pilot, after dry-run and local review** (three separate real orders):

```powershell
.\scripts\run-matrix.ps1 -Mode live -MaxRuns 3 -Formats PNG,JPG -Sizes 8000,9000 -ApproveLiveBatch
```

This loops formats first and sizes second: PNG 8000, PNG 9000, JPG 8000 (not JPG 2000). For the intended pilot of PNG 8000, PNG 9000 and JPG 2000, run the two PNG cases as one approved batch, then JPG 2000 as a separate approved single-order test. PowerShell's process execution policy may require authorization of a local script; do not change machine-wide security settings.

To run all pending formats (24 separate orders, before any other filtering):

```powershell
.\scripts\run-matrix.ps1 -Mode live -MaxRuns 24 -Formats JPG,WEBP,PDF -Sizes 2000,3000,4000,5000,6000,7000,8000,9000 -ApproveLiveBatch
```

**Do not start a full batch until the small pilot shows that the runner continues after a confirmed business failure and safely stops on uncertainty.** Existing PNG results up to 7000 are not rerun by these commands; PNG 8000 and 9000 are separate. For PDFs, output verification uses PDF-specific metadata rather than raster pixel dimensions.

No actual live submission is performed during V3 packaging. Run in your own approved DEV account. Store `.env` only locally and never share `config/auth.json` or raw traces containing authentication material.
