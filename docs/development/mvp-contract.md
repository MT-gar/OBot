# MVP implementation contract

Updated: 2026-11-21. Working contract for the current model-integration increment; not a declaration of completed functionality. The [development roadmap](../development-roadmap.md) now separates P1A foundation acceptance from P1B handoff/private-operation work.

## Current delivery and acceptance scope

The P0 fixed desktop flow has local integration evidence, including a later run on the separated base-image services. A WSL Node 24.22.3 regression passed 59 tests and 29 JavaScript syntax checks. Other runs exposed a 409 when the next task starts after the previous one reports a terminal state. Align that state with slot availability before accepting consecutive tasks. The DSH ACP host text check returned `READY` with known usage using `gpt-6.1-sol` at `max`. The current Compose entry point selects the base MVP image and defaults to direct Responses. A1 aligns the entry point with the ACP control image before the real tool runs.

P1A acceptance covers consecutive starts, real file and desktop tasks, approval rejection/expiry/conflicts, cancellation/takeover, lost-control lease expiry, separated-state persistence and runtime isolation. The runner supports explicit revocation. P1A adds bounded lease expiry and requires runner confirmation before advertising that human input is ready. Current takeover cancels the run. P1B adds pausing, handoff notes, independent observation revocation and redelegation through a new linked Run and ACP session. Browser refs must expire across handoff. See the [roadmap acceptance criteria](../development-roadmap.md).

P1B must keep logical-work usage and budgets visible across execution attempts. A fresh session cannot silently reset limits, revive approvals or replay an external operation with an unknown outcome. No new pause, resume or private-mode endpoint is implied by this contract.

## Ownership and isolation

The control process owns the provider credential, owner authentication, task state, policy and approvals. A separate desktop process owns Xvfb/Chromium/VNC and a narrow authenticated runner. Provider keys and the owner password are never mounted into the desktop process. Only the workspace directory is shared; browser profiles and control state use different volumes. Desktop and runner ports remain unpublished.

## Primary execution path: real DSH ACP

The [ACP executor](../../apps/control/src/acp.mjs) is selected with `MODEL_EXECUTOR=dsh-acp` and provides `metadata()`, `execute(context)` and `test({signal})`. The controller calls `execute` for this path. Control owns the real DSH subprocess, temporary per-attempt home, policy endpoint and authenticated MCP bridge exposing only the bounded tools below. Preserve DSH's native executor; restrict concrete tools and capability exposure instead of impersonating a provider client or bypassing provider restrictions.

The locally verified independent runtime is Node 24.22.3 with DSH 0.2.2-rc.3. ACP/Node paths and the budget plugin must be available inside control; desktop/egress must not inherit model credentials or task homes. Close sessions/processes and clean temporary homes on completion, cancellation or failure.

Successful message accounting comes from `event.data.usage`. DSH's uncached input and cache counters are disjoint; aggregate them once before presenting total input. An `assistant/attempt` failure and synthetic stream zeros do not establish settled usage. Missing/incomplete usage or an unsettled previous request blocks the next model dispatch. Preserve safe failure codes while marking usage unknown, and deduplicate repeated event sequences. The [host live test](../../scripts/verify-acp-host.mjs) uses no MCP tools; P1A separately requires actual multi-turn tool execution and approval evidence.

## Direct Responses model Module (retained implementation)

`createResponsesModel(config)` returns:

- `metadata()` -> `{configured, protocol:'responses', model, reasoningEffort, baseUrl}`. No credentials.
- `respond({input, tools, signal, maxOutputTokens})` -> `{output, outputText, usage:{inputTokens,outputTokens,totalTokens,reasoningTokens}, requestId}`.
- Throws sanitized errors with a stable `code` and optional HTTP `status`; never includes headers, keys or raw provider responses in messages.

`input`/`output` are Responses-native items. Preserve opaque reasoning items only in memory for the next request. Use `store:false`, `parallel_tool_calls:false`, `reasoning:{effort:<verified highest>}`. Never expose chain-of-thought or raw provider objects in task history/UI. The requested model is `gpt-6.1-sol` with effort `max`; selection and a real text response are verified on the ACP path. The retained direct adapter is not an automatic fallback for provider restrictions.

## Desktop runtime Module (desktop-builder)

The remote runtime retains P0 methods: `inspect`, `setViewOnly(boolean, options?)`, `openFixture`, `fillAndSubmit`, `capture`, `close`. Additionally:

`performTool(name, args, {signal, assertLease})` -> a JSON-serializable result; screenshot results may contain `{imageBase64,mimeType:'image/png',width,height}`. Controller removes image bytes from persisted logs.

Supported names/arguments:

- `desktop_screenshot {}`
- `desktop_click {x:number,y:number,button:'left'|'right'|'double'}`
- `desktop_type {text:string}`
- `desktop_key {key:string}` (small validated key/chord vocabulary)
- `desktop_scroll {direction:'up'|'down',amount:number}`
- `browser_navigate {url:string}`
- `browser_snapshot {}` -> `{url,title,text,elements:[{ref,tag,text,type?,label?,href?}]}`; redact password values, bound text size.
- `browser_click {ref:string}`
- `browser_type {ref:string,text:string}`

Do not expose arbitrary shell or JavaScript evaluation. Input actions require the active worker lease and call `assertLease` immediately before each actual input. `setViewOnly(true)` acquires a worker lease; false revokes it and cancels worker input. The client handles the worker lease internally, so the controller's P0 Interface remains compatible. All worker requests require a local secret token and bounded payloads/timeouts. Worker health reveals no secrets. VNC bridge must be reachable only on the private Compose network; no host port is published.

The configured internal fixture origin is `http://control:3180`, distinct from the owner-facing `http://localhost:3180`. Permit only this exact internal origin for fixed fixture operations; do not expose control-plane APIs through browser tools. External browser navigation is limited to public HTTP(S), rejecting credential URLs, metadata/private/link-local/loopback destinations except the explicit fixed fixture. Do not claim DNS checks alone solve all network isolation.

## Controller/agent Module (agent-builder)

Extend the existing controller while preserving all P0 methods/tests. Optional `{model}` injection activates `phase:'mvp'`; no model keeps P0 behavior. Keep one active run across demo/agent tasks and use the existing lease/generation/cancel flow.

New methods:

- `startTask({goal,allowDesktop:false})` -> `{id}`.
- `decideApproval(runId,{approvalId,decision:'approve'|'deny'})` -> current status.
- `listRuns({limit=20}={})` -> run summaries.
- `getRun(id)` -> safe persisted run, or an HttpError.

Status adds `model`, `run.kind`, `run.goal`, `run.usage`, `run.budget`, optional `run.approval`, and final `run.output`. Preserve `desktop/control/run/files/sandbox/workspacePersistent`. Emit existing `change` events for every meaningful update. Add `awaiting_approval` as an active state.

Default server-enforced limits: 12 model turns/tool steps, 5 minutes wall time, 50000 total reported tokens, 8192 output tokens per call, one active run. Clamp each request by remaining budget. No automatic retries of model requests or external side effects. Cancelling aborts in-flight fetch/tool work, rejects pending approvals and prevents subsequent inputs; report unknown usage honestly when cancellation interrupts accounting.

Tool schemas use Responses `{type:'function',name,description,parameters,strict:true}` with `additionalProperties:false`. File tools run through the existing workspace Module: `workspace_list {}`, `workspace_read {name}`, `workspace_write {name,content}`. Bound model file reads/writes. Writes and every desktop/browser mutation require a concrete, expiring approval bound to run/tool/args/generation. Read-only screenshot/browser tools are available only when `allowDesktop:true`; file task consent permits requested workspace content to be sent to the configured provider. Images stay in memory and are passed as separate Responses `input_image` content; do not persist base64 or provider reasoning. Persist safe tool summaries and usage, not typed secrets or full file contents.

## Owner-facing HTTP (lead) and UI (web-builder)

- `POST /api/tasks {goal,allowDesktop}` -> 202 `{id}`.
- `GET /api/tasks?limit=20` -> `{runs:[...]}`.
- `GET /api/tasks/<id>` -> `{run:...}`.
- `POST /api/tasks/<id>/approval {approvalId,decision}` -> updated status.
- `POST /api/model/test {}` -> a harmless bounded connection test summary; only explicit owner action triggers a paid request.
- Existing `/api/status`, `/api/events`, `/api/control/takeover`, `/api/run/cancel`, files, login/logout and `/desktop` remain compatible.

All routes require the existing authentication and trusted Origin policy. No HTTP endpoint accepts provider credentials or a model endpoint override. Show model/protocol/effort and configuration status only. New task form includes explicit desktop/screenshot consent; desktop tools remain unavailable without it. Approval UI shows the exact safe action summary and approve/deny buttons; task history and token/step/time usage are visible. Do not show invented currency costs or persist passwords in the browser.
