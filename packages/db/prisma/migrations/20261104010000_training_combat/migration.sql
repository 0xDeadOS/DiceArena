BEGIN;
CREATE TYPE "BattleOutcome" AS ENUM ('VICTORY', 'DEFEAT');
ALTER TABLE "RoomMember" ADD COLUMN "facetDust" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_dust_nonnegative" CHECK ("facetDust" >= 0);
ALTER TABLE "MapRun"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dieSnapshot" JSONB,
  ADD COLUMN "visitedNodeIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "settledLoot" JSONB,
  ADD COLUMN "lootSettledAt" TIMESTAMPTZ(3);
ALTER TABLE "MapRun" ADD CONSTRAINT "MapRun_revision_nonnegative" CHECK ("revision" >= 0);
ALTER TABLE "MapRun" ADD CONSTRAINT "MapRun_settlement_consistent"
  CHECK (
    ("settledLoot" IS NULL) = ("lootSettledAt" IS NULL)
    AND ("lootSettledAt" IS NULL OR "status" <> 'IN_PROGRESS')
    AND ("dieSnapshot" IS NULL OR (
      ("status" = 'IN_PROGRESS') = ("lootSettledAt" IS NULL)
      AND ("status" = 'IN_PROGRESS') = ("completedAt" IS NULL)
    ))
  );
ALTER TABLE "Battle"
  ADD COLUMN "nodeId" TEXT,
  ADD COLUMN "outcome" "BattleOutcome",
  ADD COLUMN "log" JSONB NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX "Battle_runId_nodeId_key" ON "Battle"("runId", "nodeId");
-- Historical foundation-only rows have no nodeId and remain readable by the hub.
ALTER TABLE "Battle" ADD CONSTRAINT "Battle_outcome_consistent"
  CHECK ("nodeId" IS NULL OR (("state" = 'FINISHED') = ("outcome" IS NOT NULL)));
COMMIT;
