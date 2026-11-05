-- Трофей рейда: единственный источник редкости UNIQUE. Обитель хранит одно
-- секретное зерно на рейд, из которого сервер выводит трофей победителю.
ALTER TABLE "RaidInstance"
  ADD COLUMN "trophySeed" CHAR(64),
  ADD COLUMN "claimedBy" UUID;

-- Трофей выдаётся только после победы и только одному участнику.
ALTER TABLE "RaidInstance"
  ADD CONSTRAINT "RaidInstance_trophy_after_victory"
    CHECK (
      ("trophySeed" IS NOT NULL AND "status" = 'DEFEATED')
      OR ("trophySeed" IS NULL)
    ),
  ADD CONSTRAINT "RaidInstance_trophy_claim_consistent"
    CHECK (
      ("claimedBy" IS NOT NULL AND "trophySeed" IS NOT NULL AND "status" = 'DEFEATED')
      OR ("claimedBy" IS NULL)
    );

CREATE INDEX "RaidInstance_trophy_pending" ON "RaidInstance"("roomId", "status")
  WHERE "claimedBy" IS NULL AND "trophySeed" IS NOT NULL;

-- Уникальный кубик всегда несёт максимальный набор свойств (2 префикса + 2 суффикса).
ALTER TABLE "Die"
  ADD CONSTRAINT "Die_unique_affixes"
    CHECK (
      "rarity" <> 'UNIQUE'
      OR (jsonb_typeof("affixes") = 'array' AND jsonb_array_length("affixes") = 4)
    );
