# Dual VPN Routing Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an unsigned, distributable macOS Electron app that safely keeps Baidu office traffic on the physical network while China Mobile business traffic remains on ZYZXVPN, including automatic recovery after VPN and network changes.

**Architecture:** A sandboxed Electron/React UI communicates through a schema-limited file protocol with a root `LaunchDaemon`. The daemon is implemented as modular macOS `zsh` scripts so it has no runtime dependency on Codex, Node.js, or a native privileged helper; it owns all route/DNS mutations, snapshots, recovery, and structured status. Installation and removal use fixed bundled scripts invoked through the macOS administrator authorization dialog.

**Tech Stack:** Electron 44.4.3, React 19.3.0, TypeScript 5.9.3, Vite 8.3.0, electron-vite 5.0.0, electron-builder 26.15.3, Vitest 5.0.1, Zod 4.6.5, Lucide React 1.47.0, Playwright 1.63.0, macOS `zsh`/`launchd`/`route`/`scutil`.

**Spec:** `docs/superpowers/specs/2026-09-22-dual-vpn-routing-assistant-design.md`

## Global Constraints

- Support macOS 13 Ventura and newer; Electron 44 is selected because its minimum macOS version matches this floor.
- Produce one unsigned Universal DMG containing both `arm64` and `x64` slices.
- The app never starts, stops, or logs in to ZYZXVPN, DuGuanJia, AccessClient, or Horizon.
- Renderer settings: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, local packaged content only, restrictive CSP.
- Root operations accept no arbitrary command, path, environment variable, or free-text argument from the renderer.
- Route/DNS changes must be idempotent, limited to declared managed entries, and reversible.
- A stale `secureutun.plist` is never sufficient evidence that the VPN is connected; the interface must exist and be active.
- No telemetry or network-content collection.
- Git commits and pushes in this plan are approval gates. Do not execute a commit or push until the user explicitly authorizes it.

## Planned File Structure

```text
dual-vpn-routing-assistant/
├── .github/workflows/release.yml             # test, Universal build, public release
├── build/icon.icns                            # generated app icon
├── docs/
│   ├── installation.md                       # unsigned app installation and removal guide
│   └── superpowers/{specs,plans}/             # approved design and this plan
├── resources/daemon/
│   ├── com.guofengming.dual-vpn-routing-assistant.plist
│   ├── daemon.sh                              # launchd loop and state transitions
│   ├── install-helper.sh                      # privileged install/upgrade entry
│   ├── uninstall-helper.sh                    # privileged restore/remove entry
│   ├── migrate-legacy.sh                      # old Skill service cleanup
│   └── lib/
│       ├── common.sh                          # constants, atomic files, safe logging
│       ├── dns.sh                             # supplemental resolver ownership
│       ├── probe.sh                           # physical/VPN/network discovery
│       ├── requests.sh                        # constrained request parser
│       ├── routes.sh                          # snapshot/apply/revert managed routes
│       └── state-machine.sh                   # pure transition and retry decisions
├── scripts/
│   ├── create-icon.sh                         # deterministic ICNS generation
│   └── verify-universal.sh                    # lipo and packaged-resource checks
├── src/
│   ├── main/
│   │   ├── index.ts                           # BrowserWindow and IPC registration
│   │   ├── daemon-client.ts                   # status reads and request writes
│   │   └── privileged-action.ts               # fixed installer/uninstaller authorization
│   ├── preload/index.ts                       # narrow contextBridge API
│   ├── renderer/
│   │   ├── App.tsx                            # shell, navigation, state polling
│   │   ├── main.tsx
│   │   ├── styles.css                         # Deep Space Blue design system
│   │   ├── components/{StatusBanner,RouteMatrix,ActionBar}.tsx
│   │   └── pages/{StatusPage,DiagnosticsPage,SettingsPage}.tsx
│   └── shared/
│       ├── protocol.ts                        # Zod schemas and TypeScript types
│       └── paths.ts                           # fixed application identifiers and paths
├── tests/
│   ├── e2e/app.spec.ts
│   ├── fixtures/{idle,active,stale-utun,network-change}/
│   ├── helpers/run-daemon-script.ts
│   ├── main/{daemon-client,privileged-action}.test.ts
│   ├── renderer/App.test.tsx
│   ├── shell/{probe,routes,dns,requests,state-machine}.test.ts
│   ├── setup.ts
│   └── shared/protocol.test.ts
├── electron-builder.yml
├── electron.vite.config.ts
├── eslint.config.js
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── vitest.config.ts
```

---

### Task 1: Project Foundation and Shared Protocol

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `tests/setup.ts`
- Create: `src/shared/protocol.ts`
- Create: `src/shared/paths.ts`
- Test: `tests/shared/protocol.test.ts`

**Interfaces:**
- Produces: `DaemonStatusSchema`, `ControlRequestSchema`, `DaemonStatus`, `ControlRequest`, `APP_ID`, `SERVICE_LABEL`, `SYSTEM_ROOT`.
- Consumes: none.

- [ ] **Step 1: Create package metadata and tool configuration**

Use Node `>=22.12.0`, pnpm 11.25.0, ESM, and these scripts:

```json
{
  "name": "dual-vpn-routing-assistant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "dist:mac": "electron-vite build && electron-builder --mac --universal --publish never",
    "verify": "tsc --noEmit && eslint . && vitest run && electron-vite build"
  }
}
```

Pin the versions listed in this plan and generate `pnpm-lock.yaml` with `pnpm install`. Configure Vitest with `environment: 'jsdom'`, `setupFiles: ['./tests/setup.ts']`, and import `@testing-library/jest-dom/vitest` from the setup file.

Use this exact dependency set:

```json
{
  "dependencies": {
    "lucide-react": "1.47.0",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@types/node": "26.6.2",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "electron": "44.4.3",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "eslint": "10.11.0",
    "globals": "17.12.0",
    "jsdom": "30.1.1",
    "prettier": "3.9.8",
    "typescript": "5.9.3",
    "vite": "8.3.0",
    "vitest": "5.0.1"
  }
}
```

- [ ] **Step 2: Write failing protocol tests**

```ts
import { describe, expect, it } from 'vitest'
import { ControlRequestSchema, DaemonStatusSchema } from '../../src/shared/protocol'

describe('ControlRequestSchema', () => {
  it('accepts a fixed repair request', () => {
    expect(ControlRequestSchema.parse({
      schemaVersion: 1,
      requestId: '018f6d76-ec4a-7d77-a9f2-0cbb48aa28a0',
      type: 'repairNow',
      createdAt: '2026-09-22T10:00:00.000Z'
    }).type).toBe('repairNow')
  })

  it('rejects arbitrary commands and paths', () => {
    expect(() => ControlRequestSchema.parse({
      schemaVersion: 1,
      requestId: '018f6d76-ec4a-7d77-a9f2-0cbb48aa28a0',
      type: 'exec',
      command: 'route delete default',
      path: '/tmp/tool'
    })).toThrow()
  })
})

describe('DaemonStatusSchema', () => {
  it('rejects an unknown phase', () => {
    expect(() => DaemonStatusSchema.parse({ schemaVersion: 1, phase: 'BROKEN' })).toThrow()
  })
})
```

- [ ] **Step 3: Run the protocol tests and verify failure**

Run: `pnpm test -- tests/shared/protocol.test.ts`

Expected: FAIL because `src/shared/protocol.ts` does not exist.

- [ ] **Step 4: Implement exact shared types**

Define:

```ts
const requestBase = z.object({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  createdAt: z.iso.datetime()
})

export const DaemonPhaseSchema = z.enum([
  'UNINSTALLED', 'IDLE', 'PROBING', 'ACTIVE',
  'NETWORK_SETTLING', 'REPAIRING', 'PAUSED', 'DEGRADED'
])

export const ControlRequestSchema = z.discriminatedUnion('type', [
  requestBase.extend({ type: z.literal('repairNow') }).strict(),
  requestBase.extend({ type: z.literal('setPaused'), value: z.boolean() }).strict(),
  requestBase.extend({ type: z.literal('setAutoEnableAtBoot'), value: z.boolean() }).strict(),
  requestBase.extend({ type: z.literal('setLogLevel'), value: z.enum(['standard', 'detailed']) }).strict()
])
```

`DaemonStatus` must include `phase`, `message`, `updatedAt`, `physicalInterface`, `physicalGateway`, `mobileInterface`, `routes`, `dns`, `lastCheckAt`, `lastNetworkChangeAt`, `lastError`, `autoEnableAtBoot`, `paused`, `daemonVersion`, and `processedRequestId`, with nullable values declared explicitly.

- [ ] **Step 5: Run checks**

Run: `pnpm run typecheck && pnpm test -- tests/shared/protocol.test.ts`

Expected: PASS.

- [ ] **Step 6: Approval-gated commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml electron.vite.config.ts tsconfig.json vitest.config.ts eslint.config.js src/shared/protocol.ts src/shared/paths.ts tests/setup.ts tests/shared/protocol.test.ts
git commit -m "build: establish secure Electron project foundation"
```

Do not execute this step without explicit user authorization.

---

### Task 2: macOS Probe Layer and Stale-utun Protection

**Files:**
- Create: `resources/daemon/lib/common.sh`
- Create: `resources/daemon/lib/probe.sh`
- Create: `tests/helpers/run-daemon-script.ts`
- Create: `tests/fixtures/idle/`
- Create: `tests/fixtures/active/`
- Create: `tests/fixtures/stale-utun/`
- Test: `tests/shell/probe.test.ts`

**Interfaces:**
- Produces shell functions: `detect_console_user`, `probe_physical_route`, `probe_mobile_interface`, `enterprise_dns_reachable`, `network_signature`.
- Produces test helpers `runDaemonScript(script: string, args: string[], fixture: string): Promise<ScriptResult>` and `runProbeFixture(fixture: string): Promise<ScriptResult>`, where `ScriptResult` is `{ exitCode: number; stdout: string; stderr: string; operations: string[][] }`.
- Produces one-line records: `physical_if|physical_gw|mobile_if|network_signature`.
- Consumes constants from `common.sh`.

- [ ] **Step 1: Create fixture command outputs**

Fixtures provide deterministic outputs for `route -n get default`, `ifconfig utun4`, `plutil -extract ifname`, `stat /dev/console`, and enterprise DNS reachability. The stale fixture returns `utun4` from plist and a failing `ifconfig utun4`.

- [ ] **Step 2: Write failing probe tests**

```ts
it('treats a plist-only utun as disconnected', async () => {
  const result = await runProbeFixture('stale-utun')
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('mobile_if=')
  expect(result.stdout).not.toContain('mobile_if=utun4')
})

it('returns the active physical gateway and live utun', async () => {
  const result = await runProbeFixture('active')
  expect(result.stdout).toContain('physical_if=en0')
  expect(result.stdout).toContain('physical_gw=172.19.132.1')
  expect(result.stdout).toContain('mobile_if=utun4')
})
```

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm test -- tests/shell/probe.test.ts`

Expected: FAIL because the probe scripts do not exist.

- [ ] **Step 4: Implement probe functions**

`probe_mobile_interface` must:

```zsh
candidate="$(/usr/bin/plutil -extract ifname raw -o - "$mobile_state" 2>/dev/null || true)"
[[ "$candidate" == utun<-> ]] || return 0
/sbin/ifconfig "$candidate" >/dev/null 2>&1 || return 0
/sbin/ifconfig "$candidate" | /usr/bin/grep -qE '^[[:space:]]+inet6? ' || return 0
print -r -- "$candidate"
```

Production mode must use absolute system command paths. Fixture command overrides are allowed only when `DUALVPN_TEST_MODE=1` and `EUID != 0`; root execution must ignore test overrides.

- [ ] **Step 5: Run probe tests**

Run: `pnpm test -- tests/shell/probe.test.ts`

Expected: PASS for idle, active, and stale plist scenarios.

- [ ] **Step 6: Approval-gated commit**

```bash
git add resources/daemon/lib/common.sh resources/daemon/lib/probe.sh tests/helpers tests/fixtures tests/shell/probe.test.ts
git commit -m "feat: detect live physical and mobile VPN interfaces"
```

Do not execute this step without explicit user authorization.

---

### Task 3: Owned Route and DNS Transactions

**Files:**
- Create: `resources/daemon/lib/routes.sh`
- Create: `resources/daemon/lib/dns.sh`
- Test: `tests/shell/routes.test.ts`
- Test: `tests/shell/dns.test.ts`

**Interfaces:**
- Produces: `snapshot_routes`, `apply_managed_routes`, `verify_managed_routes`, `revert_managed_routes`.
- Produces: `snapshot_dns`, `apply_supplemental_dns`, `verify_supplemental_dns`, `revert_supplemental_dns`.
- Produces test helper `runRouteScenario(name: string): Promise<ScriptResult & { finalManagedRoutes: string[] }>` as a thin wrapper over `runDaemonScript`.
- Consumes: `physical_if`, `physical_gw`, `mobile_if` from Task 2.

- [ ] **Step 1: Write failing route transaction tests**

```ts
it('adds only two /9 routes and two mobile DNS host routes', async () => {
  const result = await runRouteScenario('apply-active')
  expect(result.operations).toEqual([
    ['add-net', '10.0.0.0/9', '172.19.132.1'],
    ['add-net', '10.128.0.0/9', '172.19.132.1'],
    ['add-host-if', '10.57.0.96', 'utun4'],
    ['add-host-if', '10.57.0.196', 'utun4']
  ])
})

it('rolls back this transaction when the fourth operation fails', async () => {
  const result = await runRouteScenario('fail-fourth-operation')
  expect(result.exitCode).not.toBe(0)
  expect(result.finalManagedRoutes).toEqual([])
})
```

- [ ] **Step 2: Write failing DNS ownership tests**

Verify exact domains and servers, preservation of a pre-existing supplemental resolver, and removal of only the app-owned `State:/Network/Service/dual-vpn-routing-assistant-dns/DNS` key.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm test -- tests/shell/routes.test.ts tests/shell/dns.test.ts`

Expected: FAIL because transaction functions are missing.

- [ ] **Step 4: Implement route transactions**

Use exact managed entries:

```zsh
typeset -gra RECLAIM_NETS=(10.0.0.0/9 10.128.0.0/9)
typeset -gra MOBILE_DNS_IPS=(10.57.0.96 10.57.0.196)
```

Before each mutation, capture the effective route. Record every successful change in a transaction ledger. On failure, unwind the ledger in reverse order. Restoring a snapshot is allowed only when its interface exists and its gateway is reachable; otherwise leave the managed entry absent and log `snapshot_stale`.

- [ ] **Step 5: Implement supplemental DNS transactions**

Use exact values:

```zsh
typeset -gra OFFICE_DNS_IPS=(172.31.5.60 172.31.6.60)
typeset -gra MATCH_DOMAINS=(baidu.com baidu-int.com internal.baidu.com)
readonly DNS_SERVICE_KEY="dual-vpn-routing-assistant-dns"
```

Apply with `scutil`, then flush `dscacheutil` and signal `mDNSResponder`. If `family.baidu.com` does not resolve to `10.11.*`, restore the previous resolver snapshot.

- [ ] **Step 6: Run route and DNS tests**

Run: `pnpm test -- tests/shell/routes.test.ts tests/shell/dns.test.ts`

Expected: PASS, including partial-failure rollback.

- [ ] **Step 7: Approval-gated commit**

```bash
git add resources/daemon/lib/routes.sh resources/daemon/lib/dns.sh tests/shell/routes.test.ts tests/shell/dns.test.ts
git commit -m "feat: manage route and DNS changes transactionally"
```

Do not execute this step without explicit user authorization.

---

### Task 4: Recovery State Machine and Daemon Loop

**Files:**
- Create: `resources/daemon/lib/state-machine.sh`
- Create: `resources/daemon/daemon.sh`
- Create: `tests/fixtures/network-change/`
- Test: `tests/shell/state-machine.test.ts`

**Interfaces:**
- Produces: `next_phase(current, event)`, `retry_delay(attempt)`, `reconcile_once`, `write_status`.
- Consumes probe, route, and DNS functions from Tasks 2–3.

- [ ] **Step 1: Write failing state transition tests**

Cover this exact table:

```text
IDLE + vpn_up                 -> PROBING
PROBING + verification_ok     -> ACTIVE
ACTIVE + vpn_down             -> IDLE after cleanup
ACTIVE + network_changed      -> NETWORK_SETTLING after cleanup
NETWORK_SETTLING + stable     -> PROBING
any + pause                   -> PAUSED after cleanup
PAUSED + resume               -> PROBING
repair failure attempt 1..3   -> retry with 2s, 5s, 10s
repair failure attempt 4      -> DEGRADED
DEGRADED + environment_change -> PROBING
```

- [ ] **Step 2: Run transition tests and verify failure**

Run: `pnpm test -- tests/shell/state-machine.test.ts`

Expected: FAIL because the state-machine module is missing.

- [ ] **Step 3: Implement pure transition helpers**

Transitions must return values instead of mutating the network. Retry delay is:

```zsh
retry_delay() {
  case "$1" in
    1) print 2 ;;
    2) print 5 ;;
    3) print 10 ;;
    *) return 1 ;;
  esac
}
```

- [ ] **Step 4: Implement daemon reconciliation**

The loop wakes on a five-second interval and immediately after a valid request. It compares a stable network signature of physical interface, gateway, and mobile interface. Network changes trigger cleanup before a three-second settling window. `IDLE` performs read-only probes and emits no error for absent VPN.

Status writes are atomic JSON and include one human-readable `message` plus structured fields. Standard logs record state transitions and mutations only; detailed logs add probe results. Rotate at 1 MiB, retaining five files.

- [ ] **Step 5: Run state-machine tests**

Run: `pnpm test -- tests/shell/state-machine.test.ts`

Expected: PASS, including no repeated writes in steady `ACTIVE` and quiet `IDLE`.

- [ ] **Step 6: Approval-gated commit**

```bash
git add resources/daemon/lib/state-machine.sh resources/daemon/daemon.sh tests/fixtures/network-change tests/shell/state-machine.test.ts
git commit -m "feat: recover safely across VPN and network transitions"
```

Do not execute this step without explicit user authorization.

---

### Task 5: Constrained Request Channel and Electron Daemon Client

**Files:**
- Create: `resources/daemon/lib/requests.sh`
- Create: `src/main/daemon-client.ts`
- Test: `tests/shell/requests.test.ts`
- Test: `tests/main/daemon-client.test.ts`

**Interfaces:**
- Produces shell function: `consume_request(console_uid, request_path)`.
- Produces TypeScript class: `DaemonClient.readStatus(): Promise<DaemonStatus>` and `DaemonClient.send(request: ControlRequest): Promise<void>`.
- Consumes shared schemas from Task 1.

- [ ] **Step 1: Write failing security tests**

Test rejection of:

- wrong file owner;
- group/world-writable request directory;
- symlink request file;
- unknown field;
- unknown request type;
- reused request ID;
- request from a non-console user.

Test acceptance of all four declared request types.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm test -- tests/shell/requests.test.ts tests/main/daemon-client.test.ts`

Expected: FAIL because request modules are missing.

- [ ] **Step 3: Implement shell request validation**

Use `/usr/bin/stat`, `/usr/bin/plutil`, exact key counts, and explicit `case` statements. Move each accepted request to a root-owned processed path before acting, and store the last processed request ID. Never `source` request data and never pass request values to a shell command except validated booleans or enum values.

- [ ] **Step 4: Implement the Electron main-process client**

`readStatus` reads the fixed status path and parses with `DaemonStatusSchema`. Invalid or missing data returns a synthetic `UNINSTALLED` or `DEGRADED` status without exposing raw file contents.

`send` validates with `ControlRequestSchema`, writes mode `0600` to a temporary file in the pre-created per-user IPC directory, `fsync`s it, then atomically renames it to the fixed request filename.

- [ ] **Step 5: Run request-channel tests**

Run: `pnpm test -- tests/shell/requests.test.ts tests/main/daemon-client.test.ts`

Expected: PASS.

- [ ] **Step 6: Approval-gated commit**

```bash
git add resources/daemon/lib/requests.sh src/main/daemon-client.ts tests/shell/requests.test.ts tests/main/daemon-client.test.ts
git commit -m "feat: add a schema-limited daemon control channel"
```

Do not execute this step without explicit user authorization.

---

### Task 6: Privileged Install, Upgrade, Legacy Migration, and Uninstall

**Files:**
- Create: `resources/daemon/install-helper.sh`
- Create: `resources/daemon/uninstall-helper.sh`
- Create: `resources/daemon/migrate-legacy.sh`
- Create: `resources/daemon/com.guofengming.dual-vpn-routing-assistant.plist`
- Create: `src/main/privileged-action.ts`
- Test: `tests/main/privileged-action.test.ts`
- Test: `tests/shell/installer.test.ts`

**Interfaces:**
- Produces: `runPrivilegedAction('install' | 'uninstall'): Promise<PrivilegedResult>`, where `PrivilegedResult` is exactly `{ ok: boolean; action: 'install' | 'uninstall'; message: string; daemonVersion: string | null }`.
- Installs service version file and per-console-user IPC directory.
- Consumes daemon resources from Tasks 2–5.

- [ ] **Step 1: Write failing installer safety tests**

Tests must prove:

- only bundled `install-helper.sh` or `uninstall-helper.sh` can be invoked;
- paths containing quotes and spaces are encoded safely in AppleScript;
- renderer input cannot alter the script path;
- legacy label `com.openai.baidu-mobile-dual-vpn` is booted out before the new daemon starts;
- failed installation restores the prior route/DNS snapshot;
- uninstall removes the daemon only after cleanup succeeds.

- [ ] **Step 2: Run installer tests and verify failure**

Run: `pnpm test -- tests/main/privileged-action.test.ts tests/shell/installer.test.ts`

Expected: FAIL because installers are missing.

- [ ] **Step 3: Implement fixed privileged action invocation**

Use `execFile('/usr/bin/osascript', ['-e', appleScript])`. The public TypeScript API takes only the union `'install' | 'uninstall'`. Resolve the resource path inside the main process with `process.resourcesPath`; never accept it through IPC.

- [ ] **Step 4: Implement legacy migration**

Never execute the user-owned Skill script from a privileged installer. When the legacy label, state, or `/usr/local/libexec/baidu-mobile-dual-vpn` exists, run only the bundled fixed-target compatibility cleanup that mirrors the old snapshot restore. Verify restoration before deleting legacy files and record the migration outcome in the installation summary.

- [ ] **Step 5: Implement install and uninstall transactions**

Install root-owned files with explicit modes, lint the plist, snapshot before the first apply, bootstrap launchd, kickstart the label, and verify daemon version/status. Any failure unwinds files and restores network state.

Installer tests exercise the same transaction function through command adapters only when `DUALVPN_TEST_MODE=1` and `EUID != 0`. Production root execution ignores fixture inputs and always uses the exact system paths in the design.

Uninstall first requests cleanup, verifies managed entries are absent or restored, bootouts the label, removes installed files and snapshots, and leaves a user-readable final summary.

- [ ] **Step 6: Run installer tests**

Run: `pnpm test -- tests/main/privileged-action.test.ts tests/shell/installer.test.ts`

Expected: PASS.

- [ ] **Step 7: Approval-gated commit**

```bash
git add resources/daemon/install-helper.sh resources/daemon/uninstall-helper.sh resources/daemon/migrate-legacy.sh resources/daemon/com.guofengming.dual-vpn-routing-assistant.plist src/main/privileged-action.ts tests/main/privileged-action.test.ts tests/shell/installer.test.ts
git commit -m "feat: install and remove the privileged service safely"
```

Do not execute this step without explicit user authorization.

---

### Task 7: Secure Electron Shell and Preload API

**Files:**
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Test: `tests/main/window-security.test.ts`

**Interfaces:**
- Produces renderer API:

```ts
interface DualVpnApi {
  getStatus(): Promise<DaemonStatus>
  repairNow(): Promise<void>
  setPaused(value: boolean): Promise<void>
  setAutoEnableAtBoot(value: boolean): Promise<void>
  setLogLevel(value: 'standard' | 'detailed'): Promise<void>
  installService(): Promise<PrivilegedResult>
  uninstallService(): Promise<PrivilegedResult>
  exportDiagnostics(): Promise<string | null>
}
```

- Consumes `DaemonClient` and privileged actions.

- [ ] **Step 1: Write failing window security tests**

Assert `contextIsolation`, disabled Node integration, renderer sandbox, denied navigation, denied window creation, local app URL only, and exact IPC channel allowlist.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm test -- tests/main/window-security.test.ts`

Expected: FAIL because the Electron shell does not exist.

- [ ] **Step 3: Implement the BrowserWindow and IPC allowlist**

Create one 1040×700 minimum-size window. Deny all `will-navigate` destinations outside the packaged renderer and return `{ action: 'deny' }` from `setWindowOpenHandler`. Validate IPC arguments again in the main process before calling fixed methods.

- [ ] **Step 4: Implement the narrow preload bridge**

Expose named functions individually with `contextBridge.exposeInMainWorld`; never expose `ipcRenderer`, `send`, `invoke`, event objects, filesystem paths, or shell functions.

- [ ] **Step 5: Add a restrictive CSP**

The packaged renderer uses only local resources:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'">
```

- [ ] **Step 6: Run security tests**

Run: `pnpm test -- tests/main/window-security.test.ts && pnpm run typecheck`

Expected: PASS.

- [ ] **Step 7: Approval-gated commit**

```bash
git add src/main/index.ts src/preload/index.ts src/renderer/index.html tests/main/window-security.test.ts
git commit -m "feat: expose a minimal sandboxed Electron interface"
```

Do not execute this step without explicit user authorization.

---

### Task 8: Deep Space Blue Application UI

**Files:**
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/components/StatusBanner.tsx`
- Create: `src/renderer/components/RouteMatrix.tsx`
- Create: `src/renderer/components/ActionBar.tsx`
- Create: `src/renderer/pages/StatusPage.tsx`
- Create: `src/renderer/pages/DiagnosticsPage.tsx`
- Create: `src/renderer/pages/SettingsPage.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes `window.dualVpn` and `DaemonStatus`.
- Produces the approved sidebar application UI.

- [ ] **Step 1: Write failing UI behavior tests**

Tests cover:

- `IDLE` says “等待中移 VPN” and does not show an error;
- `ACTIVE` says “分流矩阵稳定” and renders physical/mobile routes;
- `NETWORK_SETTLING` explains the temporary 10–30 second interruption;
- `DEGRADED` shows the concrete last error and repair action;
- pause/resume labels switch correctly;
- install button appears only in `UNINSTALLED`;
- settings update only through the preload API;
- no control starts or stops either VPN app.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `pnpm test -- tests/renderer/App.test.tsx`

Expected: FAIL because the renderer is missing.

- [ ] **Step 3: Implement app shell and polling**

Use three navigation destinations: 状态, 诊断日志, 设置. Poll status once per second while visible and pause polling when the window is hidden. Disable mutation buttons while a request is outstanding and refresh immediately after completion.

- [ ] **Step 4: Implement the Deep Space Blue design tokens**

Use CSS custom properties scoped to `.dual-vpn-app`, `light-dark()` pairs, thin grid backgrounds, cyan focus/active states, opaque content surfaces, and readable semantic green/orange/red states. Honor `prefers-reduced-motion`; do not use looping animation.

- [ ] **Step 5: Implement pages and actions**

Status shows a two-row route matrix, overall banner, recent network event, pause/resume, and repair. Diagnostics renders structured events with copy/export. Settings includes auto-enable-at-boot, log level, version, and an uninstall confirmation dialog.

- [ ] **Step 6: Run UI checks**

Run: `pnpm test -- tests/renderer/App.test.tsx && pnpm run typecheck && pnpm run lint`

Expected: PASS.

- [ ] **Step 7: Approval-gated commit**

```bash
git add src/renderer tests/renderer/App.test.tsx
git commit -m "feat: add the Deep Space Blue routing dashboard"
```

Do not execute this step without explicit user authorization.

---

### Task 9: App-level Integration and Diagnostic Export

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/app.spec.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/daemon-client.ts`
- Modify: `src/renderer/pages/DiagnosticsPage.tsx`

**Interfaces:**
- Produces an injectable fake status/request backend for packaged app tests.
- Produces a redacted diagnostic ZIP-free text bundle selected by a native save dialog.
- Consumes all previous tasks.

- [ ] **Step 1: Write failing Electron integration tests**

Launch the built app with a non-root fixture backend and verify:

- window opens at the expected size;
- ACTIVE, IDLE, PAUSED, NETWORK_SETTLING, and DEGRADED fixtures render correctly;
- clicking repair emits exactly one `repairNow` request;
- navigation and external windows are blocked;
- diagnostics export removes `/Users/<name>` and replaces it with `$USER_HOME`.

- [ ] **Step 2: Run E2E tests and verify failure**

Run: `pnpm run build && pnpm run test:e2e`

Expected: FAIL until fixture injection and export are implemented.

- [ ] **Step 3: Implement non-production fixture injection**

Honor `DUALVPN_UI_FIXTURE_DIR` only when `app.isPackaged === false`. Packaged production builds must ignore the variable. The fixture backend implements the same `DaemonClient` interface without root access.

- [ ] **Step 4: Implement diagnostic export**

Export app version, daemon version, structured status, recent structured events, and route/DNS summaries. Replace the console username and home directory; do not include arbitrary command output, browser data, VPN credentials, or network payloads.

- [ ] **Step 5: Run all integration checks**

Run: `pnpm run build && pnpm run test:e2e && pnpm run verify`

Expected: PASS.

- [ ] **Step 6: Approval-gated commit**

```bash
git add playwright.config.ts tests/e2e/app.spec.ts src/main/index.ts src/main/daemon-client.ts src/renderer/pages/DiagnosticsPage.tsx
git commit -m "test: verify desktop flows and safe diagnostics"
```

Do not execute this step without explicit user authorization.

---

### Task 10: Universal Packaging, GitHub Release, and User Documentation

**Files:**
- Create: `electron-builder.yml`
- Create: `scripts/create-icon.sh`
- Create: `scripts/verify-universal.sh`
- Create: `build/icon.icns`
- Create: `.github/workflows/release.yml`
- Create: `README.md`
- Create: `docs/installation.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `dist/双 VPN 分流助手-<version>-universal.dmg`.
- Produces a public GitHub Release on `v*` tags.
- Consumes the complete app and daemon resource tree.

- [ ] **Step 1: Configure electron-builder**

Use:

```yaml
appId: com.guofengming.dual-vpn-routing-assistant
productName: 双 VPN 分流助手
asar: true
files:
  - out/**
extraResources:
  - from: resources/daemon
    to: daemon
mac:
  category: public.app-category.utilities
  icon: build/icon.icns
  target:
    - target: dmg
      arch: [universal]
  identity: null
```

Explicitly disable identity autodiscovery so the first release remains unsigned.

- [ ] **Step 2: Add packaging verification**

`scripts/verify-universal.sh` mounts or inspects the DMG, then runs:

```zsh
/usr/bin/lipo -archs "双 VPN 分流助手.app/Contents/MacOS/双 VPN 分流助手"
```

Require both `x86_64` and `arm64`. Also verify all daemon scripts, plist, version file, app ID, and minimum system version are present.

- [ ] **Step 3: Add GitHub Actions release workflow**

On pull requests and pushes, run `pnpm install --frozen-lockfile`, `pnpm run verify`, and shell tests on both `macos-15` (Apple Silicon) and `macos-15-intel` (Intel). On `v*` tags, build `pnpm run dist:mac`, verify the Universal binary, and publish the DMG with `softprops/action-gh-release@v2` using the repository `GITHUB_TOKEN`.

- [ ] **Step 4: Write installation and recovery documentation**

Document:

- downloading from the public Release;
- dragging the App to Applications;
- allowing an unsigned app in Privacy & Security;
- first administrator authorization;
- expected idle/active states;
- pause and repair;
- manual upgrade;
- uninstalling the service before trashing the App;
- collecting diagnostics if DuGuanJia cannot reconnect.

- [ ] **Step 5: Build and verify locally**

Run:

```bash
pnpm run verify
pnpm run dist:mac
scripts/verify-universal.sh dist/*.dmg
```

Expected: all tests pass; DMG exists; `lipo` reports `x86_64 arm64`; packaged resources and minimum macOS version match the release contract.

- [ ] **Step 6: Perform Apple Silicon smoke test**

Install the DMG on the current Apple Silicon Mac, authorize the service, verify IDLE with no VPN, connect ZYZXVPN, verify ACTIVE and Baidu intranet, switch networks, disconnect VPN, pause/resume, and uninstall. Record each result in the release checklist.

- [ ] **Step 7: Record Intel validation requirement**

Use the `macos-15-intel` GitHub runner for automated Intel launch/build checks. Also provide the same DMG to an authorized Intel Mac user for install, app launch, daemon bootstrap, IDLE state, and basic repair-flow results before declaring Intel VPN-path support fully verified. If no enterprise-network Intel machine is available, claim Intel runtime compatibility only for CI-covered app/daemon flows and leave Intel enterprise VPN-path validation explicitly unclaimed.

- [ ] **Step 8: Validate the minimum macOS version**

Run installation, first launch, daemon bootstrap, IDLE state, pause/resume, and uninstall on an authorized macOS 13 machine. If no macOS 13 machine is available, verify `LSMinimumSystemVersion=13.0` and Electron 44 compatibility metadata, then state clearly that the minimum-version runtime smoke test remains outstanding; do not describe macOS 13 runtime support as fully verified.

- [ ] **Step 9: Approval-gated repository and release operations**

After the user approves the final change summary:

```bash
git add .github build docs resources scripts src tests electron-builder.yml electron.vite.config.ts eslint.config.js package.json pnpm-lock.yaml pnpm-workspace.yaml playwright.config.ts tsconfig.json vitest.config.ts README.md
git commit -m "feat: ship the macOS dual VPN routing assistant"
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

Create `guofengming/dual-vpn-routing-assistant` only at this approval gate if it does not already exist. The pushed tag starts the public GitHub Release workflow.

Do not execute any command in this step without explicit user authorization.

---

## Final Verification Checklist

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm test`
- [ ] `pnpm run build`
- [ ] `pnpm run test:e2e`
- [ ] `pnpm run dist:mac`
- [ ] Universal binary contains `x86_64` and `arm64`
- [ ] Packaged daemon resources and LaunchDaemon plist are present
- [ ] No remote renderer resources or broad IPC APIs
- [ ] Stale plist scenario remains IDLE without route errors
- [ ] Network change cleans old managed state before reapply
- [ ] Pause and uninstall restore or safely omit stale snapshots
- [ ] Apple Silicon business-path smoke test recorded
- [ ] Intel runtime test recorded or explicitly left unclaimed
- [ ] README and unsigned-app installation guide complete
- [ ] User reviewed changes before any add/commit/push/tag/release operation
