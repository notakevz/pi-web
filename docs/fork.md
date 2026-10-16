# Fork customizations

This fork retains the upstream Pi Web package name and version. Its release base is v0.12.1; the source also incorporates upstream main through `e070e0b7322fc59db6ab97f3b69ce7dca83e1337`, including session-scanning, model-runtime, navigation, and UI updates.

## Application changes

- Browser titles and branding retain upstream behavior: **Pi Web** by default and **<project> - Pi Web** when a project is selected. The Apple web-app title, sidebar brand, PWA naming and icons also retain upstream behavior.
- The tool menu presents **plan / build / full**. Fresh conversations start in build; historical unpinned sessions and legacy API requests also retain build. Changing a conversation's mode does not change the next new conversation's default. Legacy Chat-only sessions remain tool-free.
- Plan and build constrain model tool calls to their builtin allowlists plus vetted subagent/webfetch implementations. Plan permits scout/planner roles; build permits scout/planner/worker/reviewer for complete development workflows. The trusted subagent extension must force scout/planner to read-only tools in both plan and build; worker/reviewer keep their role's builtin tools. Full enables all registered, nonhidden tools. This is a model execution policy, **not an operating-system sandbox**.
- Background running conversations receive bounded history prefetch using the existing sidebar poll, without extra SSE streams or starting sessions. Hidden/offline pages pause prefetch.
- Reasoning controls use one capability-driven menu. Supported off/on/effort options can save exact SDK-native per-model defaults. Ordinary selections remain session-scoped; model changes restore the target model's saved default without transient display mismatches.

Design details and regression boundaries are in [tool policy](agents/tools.md), [sessions](agents/sessions.md), and [models](agents/models.md).

## Source and deployment separation

This repository contains application code, portable tests, and generic documentation. Machine-specific build/activation helpers, service launchers, deployment records, real configuration, credentials, and sessions are maintained **outside this repository**.

Use the development and test commands in the [README](../README.md). Do not run production builds over a live development or deployed `.next` directory. Publishing this source does not deploy a service or publish an npm package.
