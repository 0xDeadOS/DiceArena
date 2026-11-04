BEGIN;

-- Stage 1 schema. SQL constraints below are part of the schema contract;
-- use migrations, not `prisma db push`, to preserve partial indexes/checks.
CREATE TYPE "Rarity" AS ENUM ('NORMAL', 'MAGIC', 'RARE', 'UNIQUE');
CREATE TYPE "DieBase" AS ENUM ('BONE', 'IRON', 'OBSIDIAN');
CREATE TYPE "SphereType" AS ENUM ('TEMPERING', 'FACETING', 'CASTING', 'ASCENDANCE', 'RESHAPING', 'CLEANSING');
CREATE TYPE "RunStatus" AS ENUM ('IN_PROGRESS', 'VICTORY', 'DEFEAT');
CREATE TYPE "BattleState" AS ENUM ('AWAITING_ROLL', 'AWAITING_DECISION', 'FINISHED');
CREATE TYPE "RaidStatus" AS ENUM ('ACTIVE', 'DEFEATED', 'EXPIRED');
CREATE TYPE "GameEventType" AS ENUM ('RAID_SUMMONED', 'RAID_DEFEATED', 'HIGH_PS_CRAFT');

CREATE TABLE "Room" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(32) NOT NULL,
  "telegramChatId" BIGINT NOT NULL,
  "title" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "canSendMessages" BOOLEAN NOT NULL DEFAULT true,
  "sealFragments" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Room_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Room_seals_nonnegative" CHECK ("sealFragments" >= 0),
  CONSTRAINT "Room_slug_format" CHECK ("slug" ~ '^r_[A-Za-z0-9_-]{8}$')
);
CREATE TABLE "User" (
  "id" UUID NOT NULL,
  "telegramUserId" BIGINT NOT NULL,
  "username" TEXT,
  "firstName" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "User_telegram_id_valid" CHECK ("telegramUserId" > 0)
);
CREATE TABLE "RoomMember" (
  "id" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "gold" INTEGER NOT NULL DEFAULT 150,
  "sealFragments" INTEGER NOT NULL DEFAULT 0,
  "equippedDieId" UUID,
  "vigorUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "storedVigor" INTEGER NOT NULL DEFAULT 3,
  "tutorialDone" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoomMember_balances_valid" CHECK ("gold" >= 0 AND "sealFragments" >= 0 AND "storedVigor" BETWEEN 0 AND 6)
);
CREATE TABLE "Die" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "baseType" "DieBase" NOT NULL,
  "ilvl" INTEGER NOT NULL DEFAULT 1,
  "quality" INTEGER NOT NULL DEFAULT 0,
  "rarity" "Rarity" NOT NULL DEFAULT 'NORMAL',
  "faces" JSONB NOT NULL,
  "affixes" JSONB NOT NULL DEFAULT '[]',
  "powerScore" INTEGER NOT NULL,
  "isStarter" BOOLEAN NOT NULL DEFAULT false,
  "isLocked" BOOLEAN NOT NULL DEFAULT false,
  "masterCrafted" BOOLEAN NOT NULL DEFAULT false,
  "lastVictoryAt" TIMESTAMPTZ(3),
  "lastVictoryPowerScore" INTEGER,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Die_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Die_values_valid" CHECK ("ilvl" BETWEEN 1 AND 50 AND "quality" BETWEEN 0 AND 20 AND "powerScore" >= 0),
  CONSTRAINT "Die_faces_six" CHECK (CASE WHEN jsonb_typeof("faces") = 'array' THEN jsonb_array_length("faces") = 6 ELSE false END),
  CONSTRAINT "Die_affixes_limit" CHECK (CASE WHEN jsonb_typeof("affixes") = 'array' THEN jsonb_array_length("affixes") <= 4 ELSE false END),
  CONSTRAINT "Die_victory_snapshot_valid" CHECK (("lastVictoryAt" IS NULL) = ("lastVictoryPowerScore" IS NULL) AND ("lastVictoryPowerScore" IS NULL OR "lastVictoryPowerScore" >= 0))
);
CREATE TABLE "UserCurrency" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "sphereType" "SphereType" NOT NULL,
  "amount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "UserCurrency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserCurrency_amount_nonnegative" CHECK ("amount" >= 0)
);
CREATE TABLE "MapRun" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "seed" CHAR(64) NOT NULL,
  "hasVigorBoost" BOOLEAN NOT NULL DEFAULT true,
  "status" "RunStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "currentNodeId" TEXT NOT NULL DEFAULT 'start',
  "dagMapData" JSONB NOT NULL,
  "playerHp" INTEGER NOT NULL,
  "playerMaxHp" INTEGER NOT NULL,
  "accumulatedLoot" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "MapRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MapRun_hp_valid" CHECK ("playerMaxHp" > 0 AND "playerHp" BETWEEN 0 AND "playerMaxHp")
);
CREATE TABLE "Battle" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "battleSeed" CHAR(64) NOT NULL,
  "stepIndex" INTEGER NOT NULL DEFAULT 0,
  "state" "BattleState" NOT NULL DEFAULT 'AWAITING_ROLL',
  "currentRolledFace" INTEGER,
  "rerollsLeft" INTEGER NOT NULL DEFAULT 1,
  "focusCharges" INTEGER NOT NULL DEFAULT 0,
  "enemyType" TEXT NOT NULL,
  "enemyHp" INTEGER NOT NULL,
  "enemyMaxHp" INTEGER NOT NULL,
  "enemyShield" INTEGER NOT NULL DEFAULT 0,
  "playerShield" INTEGER NOT NULL DEFAULT 0,
  "currentIntent" JSONB NOT NULL,
  "turnNumber" INTEGER NOT NULL DEFAULT 1,
  "effects" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "Battle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Battle_face_valid" CHECK ("currentRolledFace" IS NULL OR "currentRolledFace" BETWEEN 1 AND 6),
  CONSTRAINT "Battle_decision_has_face" CHECK (("state" = 'AWAITING_DECISION') = ("currentRolledFace" IS NOT NULL)),
  CONSTRAINT "Battle_values_valid" CHECK ("stepIndex" >= 0 AND "rerollsLeft" >= 0 AND "focusCharges" BETWEEN 0 AND 3 AND "enemyMaxHp" > 0 AND "enemyHp" BETWEEN 0 AND "enemyMaxHp" AND "enemyShield" >= 0 AND "playerShield" >= 0 AND "turnNumber" >= 1)
);
CREATE TABLE "RaidInstance" (
  "id" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "bossName" TEXT NOT NULL,
  "maxHp" INTEGER NOT NULL,
  "currentHp" INTEGER NOT NULL,
  "phase" INTEGER NOT NULL DEFAULT 1,
  "status" "RaidStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "RaidInstance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RaidInstance_values_valid" CHECK ("maxHp" > 0 AND "currentHp" BETWEEN 0 AND "maxHp" AND "phase" BETWEEN 1 AND 3 AND "expiresAt" > "createdAt")
);
CREATE TABLE "RaidAttack" (
  "id" UUID NOT NULL,
  "raidId" UUID NOT NULL,
  "memberId" UUID NOT NULL,
  "damageDealt" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RaidAttack_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RaidAttack_damage_nonnegative" CHECK ("damageDealt" >= 0)
);
CREATE TABLE "IdempotencyRecord" (
  "key" UUID NOT NULL,
  "memberId" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("memberId", "key"),
  CONSTRAINT "IdempotencyRecord_status_valid" CHECK ("responseStatus" BETWEEN 100 AND 599 AND "expiresAt" > "createdAt")
);
CREATE TABLE "GameEvent" (
  "id" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "memberId" UUID,
  "eventType" "GameEventType" NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GameEvent_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "Room_slug_key" ON "Room"("slug");
CREATE UNIQUE INDEX "Room_telegramChatId_key" ON "Room"("telegramChatId");
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");
CREATE UNIQUE INDEX "RoomMember_equippedDieId_key" ON "RoomMember"("equippedDieId");
CREATE UNIQUE INDEX "RoomMember_roomId_userId_key" ON "RoomMember"("roomId", "userId");
CREATE UNIQUE INDEX "RoomMember_equippedDieId_id_key" ON "RoomMember"("equippedDieId", "id");
CREATE INDEX "RoomMember_userId_idx" ON "RoomMember"("userId");
CREATE UNIQUE INDEX "Die_id_ownerId_key" ON "Die"("id", "ownerId");
CREATE INDEX "Die_ownerId_lastVictoryAt_idx" ON "Die"("ownerId", "lastVictoryAt");
CREATE UNIQUE INDEX "UserCurrency_ownerId_sphereType_key" ON "UserCurrency"("ownerId", "sphereType");
CREATE INDEX "MapRun_ownerId_status_idx" ON "MapRun"("ownerId", "status");
CREATE INDEX "MapRun_ownerId_completedAt_idx" ON "MapRun"("ownerId", "completedAt");
CREATE INDEX "Battle_runId_idx" ON "Battle"("runId");
CREATE INDEX "RaidInstance_roomId_status_idx" ON "RaidInstance"("roomId", "status");
CREATE INDEX "RaidAttack_memberId_createdAt_idx" ON "RaidAttack"("memberId", "createdAt");
CREATE INDEX "RaidAttack_raidId_memberId_idx" ON "RaidAttack"("raidId", "memberId");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
CREATE UNIQUE INDEX "GameEvent_dedupKey_key" ON "GameEvent"("dedupKey");
CREATE INDEX "GameEvent_sentAt_createdAt_idx" ON "GameEvent"("sentAt", "createdAt");

-- Business invariants not representable as ordinary Prisma @@unique attributes.
CREATE UNIQUE INDEX "Die_one_starter_per_owner" ON "Die"("ownerId") WHERE "isStarter";
CREATE UNIQUE INDEX "MapRun_one_active_per_owner" ON "MapRun"("ownerId") WHERE "status" = 'IN_PROGRESS';
CREATE UNIQUE INDEX "Battle_one_unfinished_per_run" ON "Battle"("runId") WHERE "state" <> 'FINISHED';
CREATE UNIQUE INDEX "RaidInstance_one_active_per_room" ON "RaidInstance"("roomId") WHERE "status" = 'ACTIVE';

ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Die" ADD CONSTRAINT "Die_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "RoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_equippedDieId_id_fkey" FOREIGN KEY ("equippedDieId", "id") REFERENCES "Die"("id", "ownerId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "UserCurrency" ADD CONSTRAINT "UserCurrency_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "RoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MapRun" ADD CONSTRAINT "MapRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "RoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Battle" ADD CONSTRAINT "Battle_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MapRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RaidInstance" ADD CONSTRAINT "RaidInstance_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RaidAttack" ADD CONSTRAINT "RaidAttack_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "RaidInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RaidAttack" ADD CONSTRAINT "RaidAttack_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
