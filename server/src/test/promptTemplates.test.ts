import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPromptTemplate, loadPromptTemplates, resolveTemplate } from "../services/promptTemplates.js";

describe("promptTemplates", () => {
  it("loads the predefined templates from promptTemplates.json", () => {
    const templates = loadPromptTemplates();
    assert.ok(templates.length >= 1, "expected at least one template");
    const ids = templates.map((t) => t.id);
    assert.ok(ids.includes("summarize"), "expected the summarize template");
    assert.ok(ids.includes("default"), "expected the default template");
  });

  it("looks up a template by id", () => {
    const t = getPromptTemplate("translate");
    assert.ok(t, "translate template should exist");
    assert.equal(t!.id, "translate");
    assert.deepEqual(t!.variables, ["text", "language"]);
  });

  it("returns null for an unknown template id", () => {
    assert.equal(getPromptTemplate("does-not-exist"), null);
  });

  it("substitutes declared {{variables}} into the prompt text", () => {
    const t = getPromptTemplate("translate")!;
    const out = resolveTemplate(t, { text: "hello", language: "French" });
    assert.ok(out.includes("into French"), out);
    assert.ok(out.includes("hello"), out);
    assert.ok(!out.includes("{{"), "no leftover placeholders");
  });

  it("substitutes undeclared placeholders too", () => {
    const out = resolveTemplate(
      { id: "x", description: "", promptText: "Hi {{name}}, {{x}}", variables: ["name"] },
      { name: "Sam", x: "bye" },
    );
    assert.equal(out, "Hi Sam, bye");
  });

  it("leaves missing variables blank", () => {
    const out = resolveTemplate(
      { id: "x", description: "", promptText: "[{{a}}][{{b}}]", variables: ["a", "b"] },
      { a: "1" },
    );
    assert.equal(out, "[1][]");
  });
});
