import { assert } from "chai";
import * as dsh from "../src/dsh/store";
import { searchConversationIndex } from "../src/shared/conversationSearchIndex";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

describe("DSH durable conversation store", function () {
  let db: SqliteHarness;
  let original: unknown;
  beforeEach(async function () {
    original = (globalThis as any).Zotero;
    resetConversationStoreProcessStateForTests();
    db = installSqliteZotero({ realTransactions: true });
    await dsh.initDshStore();
  });
  afterEach(function () {
    db.db.close();
    (globalThis as any).Zotero = original;
    resetConversationStoreProcessStateForTests();
  });
  it("persists ACP binding, model and transcript across store initialization and isolates paper scope", async function () {
    const a = (await dsh.createDshPaperConversation(1, 77))!;
    const b = (await dsh.createDshPaperConversation(1, 78))!;
    assert.isAtLeast(a.conversationKey, 2e15);
    assert.isBelow(a.conversationKey, 3e15);
    assert.notEqual(a.conversationKey, b.conversationKey);
    assert.isTrue(
      await dsh.upsertDshConversationSummary({
        ...a,
        providerSessionId: "session-A",
        cwd: "C:/With Spaces/Paper A",
        runtimeBinding: "binding-A",
        model: "opaque-model",
        effort: "opaque-effort",
      }),
    );
    await dsh.appendDshMessage(a.conversationKey, {
      role: "user",
      text: "needlealpha",
      timestamp: Date.now(),
    });
    await dsh.initDshStore();
    const restored = (await dsh.getDshConversationSummary(a.conversationKey))!;
    assert.equal(restored.providerSessionId, "session-A");
    assert.equal(restored.runtimeBinding, "binding-A");
    assert.equal(restored.runtimeGeneration, "0");
    assert.equal(restored.model, "opaque-model");
    assert.equal(restored.effort, "opaque-effort");
    assert.equal(
      (await dsh.loadDshConversation(a.conversationKey))[0].text,
      "needlealpha",
    );
    assert.equal(
      (await dsh.getDshConversationSummary(b.conversationKey))!
        .providerSessionId,
      undefined,
    );
    assert.isFalse(
      await dsh.upsertDshConversationSummary({ ...restored, paperItemID: 78 }),
    );
  });
  it("searches and renames only DSH rows, and clear advances the durable generation and removes session identity", async function () {
    const chat = (await dsh.createDshGlobalConversation(1))!;
    const key = chat.conversationKey;
    await dsh.upsertDshConversationSummary({
      ...chat,
      providerSessionId: "old",
      cwd: "old",
      runtimeBinding: "old",
    });
    await dsh.appendDshMessage(key, {
      role: "user",
      text: "dshuniquesearch",
      timestamp: Date.now(),
    });
    await dsh.setDshConversationTitle(key, "Renamed DSH");
    const matches = await searchConversationIndex({
      system: "dsh",
      libraryID: 1,
      query: "dshuniquesearch",
      refresh: true,
    });
    assert.deepEqual(
      matches.map((m) => m.conversationKey),
      [key],
    );
    const generation = getConversationWriteGeneration(key);
    await dsh.clearDshConversation(key);
    const cleared = (await dsh.getDshConversationSummary(key))!;
    assert.equal(cleared.runtimeGeneration, "1");
    assert.isUndefined(cleared.providerSessionId);
    assert.isUndefined(cleared.runtimeBinding);
    assert.isAbove(getConversationWriteGeneration(key), generation);
    assert.isEmpty(await dsh.loadDshConversation(key));
    await dsh.initDshStore();
    assert.equal(
      (await dsh.getDshConversationSummary(key))!.runtimeGeneration,
      "1",
    );
    await dsh.clearDshConversation(key);
    assert.equal(
      (await dsh.getDshConversationSummary(key))!.runtimeGeneration,
      "2",
    );
    await dsh.deleteDshConversationLocalRows(key);
    assert.isNull(await dsh.getDshConversationSummary(key));
  });
});
