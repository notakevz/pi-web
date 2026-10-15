import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  clampThinkingLevel,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent, fetch } from "undici";

// Deliberately self-contained: no models.json/auth.json, home directory, catalog
// refresh, extension loading, or real model endpoint. Both SDK stores are in memory.
const qwen = {
  id: "qwen-fixture",
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: "xhigh",
    max: null,
  },
  compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
};
const gemma = {
  id: "gemma-fixture",
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
    max: null,
  },
  compat: {
    supportsReasoningEffort: false,
    supportsDeveloperRole: false,
    thinkingFormat: "chat-template",
    chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
  },
};

async function mockEndpoint(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer mock-only-not-a-secret");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      requests.push(payload);
      assert.equal(payload.stream, true);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        id: "mock-response",
        object: "chat.completion.chunk",
        created: 1,
        model: payload.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  // A direct dispatcher bypasses any inherited proxy settings. Reject redirects
  // and every URL except this test's exact loopback endpoint before network I/O.
  const dispatcher = new Agent();
  t.after(async () => {
    await dispatcher.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const guardedFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, `${baseUrl}/chat/completions`, "non-mock network request refused");
    return fetch(input, { ...init, dispatcher, redirect: "error" });
  };
  const models = createModels();
  const fixtures = [qwen, gemma].map((fixture) => ({
    ...structuredClone(fixture),
    name: fixture.id,
    provider: "thinking-fixture",
    api: "openai-completions",
    baseUrl,
    reasoning: true,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  models.setProvider(createProvider({
    id: "thinking-fixture",
    baseUrl,
    auth: { apiKey: { name: "Mock only", resolve: async () => ({ auth: { apiKey: "mock-only-not-a-secret" } }) } },
    models: fixtures,
    api: openAICompletionsApi(),
  }));
  return {
    model: (fixture) => models.getModel("thinking-fixture", fixture.id),
    async request(model, reasoning) {
      const count = requests.length;
      const result = await models.completeSimple(model, {
        messages: [{ role: "user", content: "Mock request only", timestamp: 1 }],
      }, {
        apiKey: "mock-only-not-a-secret",
        reasoning,
        maxTokens: 32,
        fetch: guardedFetch,
        signal: AbortSignal.timeout(5000),
        retry: { maxRetries: 0 },
      });
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
      assert.equal(requests.length, count + 1, "one actual HTTP request expected");
      const payload = requests.at(-1);
      assert.equal(payload.model, model.id);
      return payload;
    },
  };
}

function assertQwenWire(payload, effective) {
  assert.equal(payload.enable_thinking, effective !== "off");
  if (effective === "off") {
    assert.equal(Object.hasOwn(payload, "reasoning_effort"), false, "off must omit effort, not send none");
  } else {
    assert.equal(payload.reasoning_effort, effective, "Qwen efforts must not collapse to medium");
  }
  assert.equal(Object.hasOwn(payload, "chat_template_kwargs"), false);
}

function assertGemmaWire(payload, effective) {
  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: effective !== "off" });
  assert.equal(Object.hasOwn(payload, "enable_thinking"), false);
  assert.equal(Object.hasOwn(payload, "reasoning_effort"), false);
}

test("Qwen3.8 preserves independent off/low/medium/xhigh controls on the actual wire", async (t) => {
  const mock = await mockEndpoint(t);
  const model = mock.model(qwen);
  assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "medium", "xhigh"]);
  for (const level of ["off", "low", "medium", "xhigh"]) {
    await t.test(level, async () => {
      assert.equal(clampThinkingLevel(model, level), level);
      assertQwenWire(await mock.request(model, level), level);
    });
  }
  for (const [requested, effective] of [["minimal", "low"], ["high", "xhigh"], ["max", "xhigh"]]) {
    await t.test(`unsupported ${requested} clamps to ${effective}`, async () => {
      assert.equal(clampThinkingLevel(model, requested), effective);
      assertQwenWire(await mock.request(model, requested), effective);
    });
  }
  await t.test("omitted reasoning disables thinking without effort", async () => {
    assertQwenWire(await mock.request(model, undefined), "off");
  });
  await t.test("null off is unsupported and clamps to low, not disabled", async () => {
    const withoutOff = { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
    assert.deepEqual(getSupportedThinkingLevels(withoutOff), ["low", "medium", "xhigh"]);
    assert.equal(clampThinkingLevel(withoutOff, "off"), "low");
    assertQwenWire(await mock.request(withoutOff, "off"), "low");
  });
});

test("Gemma exposes binary off/on via chat_template_kwargs, never reasoning_effort", async (t) => {
  const mock = await mockEndpoint(t);
  const model = mock.model(gemma);
  assert.deepEqual(getSupportedThinkingLevels(model), ["off", "medium"]);
  for (const level of ["off", "medium"]) {
    await t.test(level, async () => {
      assert.equal(clampThinkingLevel(model, level), level);
      assertGemmaWire(await mock.request(model, level), level);
    });
  }
  for (const requested of ["minimal", "low", "high", "xhigh", "max"]) {
    await t.test(`unsupported ${requested} clamps to medium/on`, async () => {
      assert.equal(clampThinkingLevel(model, requested), "medium");
      assertGemmaWire(await mock.request(model, requested), "medium");
    });
  }
  await t.test("null off is unsupported and clamps to medium/on", async () => {
    const withoutOff = { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
    assert.deepEqual(getSupportedThinkingLevels(withoutOff), ["medium"]);
    assert.equal(clampThinkingLevel(withoutOff, "off"), "medium");
    assertGemmaWire(await mock.request(withoutOff, "off"), "medium");
  });
});
