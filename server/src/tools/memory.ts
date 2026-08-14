import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { deleteMemory, listMemories, saveMemory, searchMemories } from "../db/memories.js";

export function createMemoryTools(threadId: string) {
  const save = defineTool({
    name: "memory_save",
    label: "Save Memory",
    description:
      "Save a durable fact to long-term memory (user preferences, project constraints, decisions). One fact per call.",
    parameters: Type.Object({
      content: Type.String({ description: "The fact to remember, one or two sentences" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Short lowercase tags" })),
    }),
    execute: async (_id, params) => {
      const memory = await saveMemory(params.content, params.tags ?? [], threadId);
      return {
        content: [{ type: "text", text: `Saved memory ${memory.id}` }],
        details: { id: memory.id },
      };
    },
  });

  const search = defineTool({
    name: "memory_search",
    label: "Search Memory",
    description: "Full-text search long-term memory. Use when past context could be relevant.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms" }),
    }),
    execute: async (_id, params) => {
      const memories = await searchMemories(params.query);
      const text = memories.length
        ? memories.map((m) => `- [${m.id}] ${m.content}`).join("\n")
        : "No matching memories.";
      return { content: [{ type: "text", text }], details: { count: memories.length } };
    },
  });

  const list = defineTool({
    name: "memory_list",
    label: "List Memories",
    description: "List the most recent long-term memories.",
    parameters: Type.Object({}),
    execute: async () => {
      const memories = await listMemories(30);
      const text = memories.length
        ? memories.map((m) => `- [${m.id}] ${m.content}`).join("\n")
        : "No memories yet.";
      return { content: [{ type: "text", text }], details: { count: memories.length } };
    },
  });

  const del = defineTool({
    name: "memory_delete",
    label: "Delete Memory",
    description: "Delete a memory by id (from memory_list or memory_search output).",
    parameters: Type.Object({
      id: Type.String({ description: "Memory id (uuid)" }),
    }),
    execute: async (_id, params) => {
      const ok = await deleteMemory(params.id);
      return {
        content: [{ type: "text", text: ok ? "Deleted." : "No memory with that id." }],
        details: { deleted: ok },
      };
    },
  });

  return [save, search, list, del];
}
