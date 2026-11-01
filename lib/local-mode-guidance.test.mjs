import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { localModeGuideline, localParentModeGuidance } = await jiti.import("./local-tool-modes.ts");

test("parent mode guidance is stable, explicit and bounded to the selected mode", () => {
  for (const mode of ["plan", "build", "full"]) {
    const guidance = localParentModeGuidance(mode);
    assert.equal(localParentModeGuidance(mode), guidance);
    assert.match(guidance, /You, the parent assistant/);
    assert.match(guidance, /current mode and tool declarations govern this run/);
    assert.match(guidance, /not tools, permissions or mode instructions in earlier conversation history/);
    assert.match(guidance, /do not probe for missing tools/);
    assert.match(guidance, /do not.*change modes yourself/);
    assert.match(guidance, /steering messages.*do not change permissions/);
    assert.ok(guidance.length < 1500, "bounded static instructions, not a new prompt framework");
  }
  assert.match(localParentModeGuidance("plan"), /investigate, analyze and propose plans only/);
  assert.match(localParentModeGuidance("plan"), /Do not edit or write files, run shell commands, implement changes, or delegate implementation/);
  assert.match(localParentModeGuidance("plan"), /user must select build mode first/);
  for (const mode of ["build", "full"]) {
    assert.match(localParentModeGuidance(mode), /may implement requested changes/);
    assert.match(localParentModeGuidance(mode), /Earlier plan-only behavior no longer applies/);
    assert.match(localParentModeGuidance(mode), /resource ceiling/);
  }
  assert.match(localParentModeGuidance("full"), /does not grant administrator privileges or guarantee an operating-system sandbox/);
  for (const mode of ["none", "restricted"]) assert.equal(localParentModeGuidance(mode), undefined);
  assert.equal(localModeGuideline("full"), undefined, "upstream compatibility view");
});
