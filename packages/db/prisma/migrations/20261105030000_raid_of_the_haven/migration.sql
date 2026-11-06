-- Рейд Обители: призванный босс на 48 часов, шесть раундов, три рога в сутки на участника.
ALTER TABLE "RaidInstance"
  ADD COLUMN "summonedById" UUID,
  ADD COLUMN "shield" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "defeatedAt" TIMESTAMPTZ(3);

ALTER TABLE "RaidInstance" ALTER COLUMN "phase" SET DEFAULT 1;

ALTER TABLE "RaidAttack"
  ADD COLUMN "attackSeed" CHAR(64),
  ADD COLUMN "state" "BattleState" NOT NULL DEFAULT 'AWAITING_ROLL',
  ADD COLUMN "rollsUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "currentRolledFace" INTEGER,
  ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "action" TEXT,
  ADD COLUMN "faceValue" INTEGER,
  ADD COLUMN "finishedAt" TIMESTAMPTZ(3);

ALTER TABLE "RaidAttack" ALTER COLUMN "damageDealt" SET DEFAULT 0;

-- Индекс «один активный рейд на Обитель» создан ещё в первой миграции, здесь не дублируется.

-- Участник не может держать два незавершённых удара по одному рейду.
CREATE UNIQUE INDEX "RaidAttack_one_unfinished_per_member" ON "RaidAttack"("raidId", "memberId")
  WHERE "state" <> 'FINISHED';

CREATE INDEX "RaidAttack_raid_round" ON "RaidAttack"("raidId", "round");

-- Первая миграция ограничивала рейд тремя фазами; теперь их шесть.
ALTER TABLE "RaidInstance" DROP CONSTRAINT "RaidInstance_values_valid";

ALTER TABLE "RaidInstance"
  ADD CONSTRAINT "RaidInstance_phase_bounds" CHECK ("phase" BETWEEN 1 AND 6),
  ADD CONSTRAINT "RaidInstance_maxhp_positive" CHECK ("maxHp" > 0),
  ADD CONSTRAINT "RaidInstance_hp_bounds"
    CHECK ("maxHp" > 0 AND "currentHp" >= 0 AND "currentHp" <= "maxHp"),
  ADD CONSTRAINT "RaidInstance_shield_nonnegative" CHECK ("shield" >= 0),
  ADD CONSTRAINT "RaidInstance_revision_nonnegative" CHECK ("revision" >= 0),
  ADD CONSTRAINT "RaidInstance_expiry_after_start" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "RaidInstance_status_consistent"
    CHECK (
      ("status" = 'DEFEATED' AND "defeatedAt" IS NOT NULL AND "currentHp" = 0)
      OR ("status" <> 'DEFEATED' AND "defeatedAt" IS NULL)
    );

ALTER TABLE "RaidAttack"
  ADD CONSTRAINT "RaidAttack_round_bounds" CHECK ("round" BETWEEN 1 AND 6),
  ADD CONSTRAINT "RaidAttack_rolls_bounded" CHECK ("rollsUsed" >= 0 AND "rollsUsed" <= 2),
  ADD CONSTRAINT "RaidAttack_face_valid"
    CHECK ("currentRolledFace" IS NULL OR "currentRolledFace" BETWEEN 1 AND 6),
  ADD CONSTRAINT "RaidAttack_state_consistent"
    CHECK (
      ("state" = 'FINISHED' AND "finishedAt" IS NOT NULL AND "currentRolledFace" IS NULL
        AND "action" IS NOT NULL AND "faceValue" IS NOT NULL)
      OR ("state" <> 'FINISHED' AND "finishedAt" IS NULL)
    ),
  ADD CONSTRAINT "RaidAttack_seed_only_while_open"
    CHECK ("attackSeed" IS NOT NULL OR "state" = 'FINISHED');
