# IrisClient — native macOS scaffold

A minimal SwiftUI client against Iris's new `/api/*` JSON surface
(`src/admin/server.ts`). This is a day-1 scaffold, not a finished app:
one window, one text field to ask Iris a question, one list showing open
nudges. It exists to prove the wiring — a native client talking to the
real Iris runtime over HTTP — not to be feature-complete.

**Status: written, not yet built or run.** This was written in a Linux
container with no Swift toolchain and no Xcode, so it has not been
compiled, launched, or clicked through. Treat it as a draft to open on a
real Mac, not as verified working code — consistent with how every other
milestone in this project only gets marked "implemented" after a real
typecheck/test pass, and "live-verified" only after someone actually runs
it. Compile errors or API mismatches are expected on the first attempt;
none of this is guaranteed to work until that happens on your machine.

## What it talks to

Two endpoints added to the existing admin server, running wherever you
already run `npm run dev:admin` (default `http://localhost:4000`):

- `POST /api/ask` — `{"question": "..."}` → `{"question", "answer"}`, the
  same `answerQuestion()` the HTML `/ask` admin page already calls.
- `GET /api/nudges` — the same active-nudges list the HTML `/nudges` page
  shows, as JSON.

## Running it (on a real Mac, with Xcode's command-line tools installed)

```bash
cd apple-client/IrisClient
swift build
swift run
```

Or open the `IrisClient` folder directly in Xcode (File → Open, pick the
folder — Xcode recognizes a `Package.swift` and generates a scheme for
you) if you want to run it as a normal windowed app with breakpoints.

By default it points at `http://127.0.0.1:4000`. The Iris admin server
needs to actually be running (`npm run dev:admin` from the repo root) for
it to have anything to talk to.

## What's deliberately not here yet

- No voice input (Apple Speech framework) — text only, for now.
- No Core ML — no model runs on-device in this client; both endpoints
  call into the existing Node/Ollama backend.
- No packaging as a real `.app` bundle, no app icon, no entitlements.
- No tests. (`XCTest` target is a natural next step before this grows.)

This is the "day 1–2: SwiftUI shell talks to the backend" slice of a
larger planned native-client milestone — see the project write-up for the
full scope and what's intentionally sequenced after this.
