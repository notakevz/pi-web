# Fork customizations

This fork retains the upstream Pi Web package name and version. Its current base is v0.12.1, with the upstream documentation changes through `7cc1803140679f2609febdf792bf5deeb3c636a1`.

## Application changes

- The browser tab title stays **Pi**, independently of the selected project. The sidebar brand and PWA naming retain upstream behavior.
- The tool menu presents **plan / build / full**. Fresh conversations start in full; historical unpinned sessions and legacy API requests retain build. Changing a conversation's mode does not change the next new conversation's default. Legacy Chat-only sessions remain tool-free.
- Plan and build constrain model tool calls to their builtin allowlists plus vetted subagent/webfetch implementations. Plan permits scout/planner roles; build permits worker/reviewer. Full enables all registered, nonhidden tools. This is a model execution policy, **not an operating-system sandbox**.
- Background running conversations receive bounded history prefetch using the existing sidebar poll, without extra SSE streams or starting sessions. Hidden/offline pages pause prefetch.
- Reasoning controls use one capability-driven menu. Supported off/on/effort options can save exact SDK-native per-model defaults. Ordinary selections remain session-scoped; model changes restore the target model's saved default without transient display mismatches.

Design details and regression boundaries are in [tool policy](agents/tools.md), [sessions](agents/sessions.md), and [models](agents/models.md).

## Source and deployment separation

This repository contains application code, portable tests, and generic documentation. Machine-specific build/activation helpers, service launchers, deployment records, real configuration, credentials, and sessions are maintained **outside this repository**.

Use the development and test commands in the [README](../README.md). Do not run production builds over a live development or deployed `.next` directory. Publishing this source does not deploy a service or publish an npm package.
