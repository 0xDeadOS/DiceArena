BEGIN;
CREATE TYPE "RunMode" AS ENUM ('TRAINING', 'EXPEDITION');
ALTER TABLE "RoomMember"
  ADD COLUMN "tutorialTrainingWon" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tutorialCrafted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tutorialRewardClaimed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "highestExpeditionLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MapRun"
  ADD COLUMN "mode" "RunMode" NOT NULL DEFAULT 'TRAINING',
  ADD COLUMN "level" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "enemyScale" INTEGER NOT NULL DEFAULT 600;
-- Preserve legitimate stage-2/3 progress. Existing snapshots are still training at scale 600.
-- Bump economic revision so old cached Hub JSON cannot erase the new progress fields.
UPDATE "RoomMember" m SET
  "tutorialTrainingWon" = m."tutorialDone" OR EXISTS (SELECT 1 FROM "MapRun" r WHERE r."ownerId"=m.id AND r.status='VICTORY' AND r."dieSnapshot" IS NOT NULL),
  "tutorialCrafted" = m."tutorialDone" OR EXISTS (SELECT 1 FROM "Die" d WHERE d."ownerId"=m.id AND d."contentVersion">0),
  "tutorialRewardClaimed" = m."tutorialDone",
  "inventoryRevision" = m."inventoryRevision" + 1;
ALTER TABLE "RoomMember"
  ADD CONSTRAINT "RoomMember_expedition_level" CHECK ("highestExpeditionLevel" BETWEEN 0 AND 50),
  ADD CONSTRAINT "RoomMember_tutorial_complete" CHECK (NOT "tutorialDone" OR ("tutorialTrainingWon" AND "tutorialCrafted" AND "tutorialRewardClaimed"));
ALTER TABLE "MapRun" ADD CONSTRAINT "MapRun_mode_level_scale" CHECK (
  (mode='TRAINING' AND level=0 AND "enemyScale"=600) OR
  (mode='EXPEDITION' AND level BETWEEN 1 AND 50 AND "enemyScale" BETWEEN 1000 AND 5000 AND "hasVigorBoost")
);
CREATE UNIQUE INDEX "MapRun_id_ownerId_key" ON "MapRun"(id, "ownerId");
CREATE TABLE "PendingDrop" (
  id UUID PRIMARY KEY,
  "ownerId" UUID NOT NULL REFERENCES "RoomMember"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "runId" UUID NOT NULL,
  "dieData" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingDrop_run_owner_fkey" FOREIGN KEY ("runId", "ownerId") REFERENCES "MapRun"(id, "ownerId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PendingDrop_identity" CHECK (jsonb_typeof("dieData")='object' AND "dieData" ? 'id' AND "dieData"->>'id'=id::text)
);
CREATE INDEX "PendingDrop_ownerId_createdAt_idx" ON "PendingDrop"("ownerId", "createdAt");
COMMIT;
