BEGIN;
ALTER TABLE "RoomMember" ADD COLUMN "inventoryRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_inventory_revision_nonnegative" CHECK ("inventoryRevision" >= 0);
ALTER TABLE "Die" ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Die" ADD CONSTRAINT "Die_content_version_nonnegative" CHECK ("contentVersion" >= 0);

-- Enforce capacity even for future drop/grant code. Same parent lock as all services.
CREATE FUNCTION "check_die_capacity"() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."ownerId" = OLD."ownerId" THEN
    RETURN NEW;
  END IF;
  PERFORM id FROM "RoomMember" WHERE id = NEW."ownerId" FOR UPDATE;
  IF (SELECT count(*) FROM "Die" WHERE "ownerId" = NEW."ownerId") >= 12 THEN
    RAISE EXCEPTION 'Inventory capacity exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Die_inventory_capacity" BEFORE INSERT OR UPDATE OF "ownerId" ON "Die"
FOR EACH ROW EXECUTE FUNCTION "check_die_capacity"();
COMMIT;
