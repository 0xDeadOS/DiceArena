import { SPHERE_TYPES } from '@dicebound/shared-types';
import type { HubDTO, InventoryDTO } from '@dicebound/shared-types';
import {
  craftRejection,
  dismantleDust,
  dismantlePermission,
  isDestructiveCraft,
  masterFacetCost,
  masterFacetRejection,
  POWER_SCORE_MODEL,
} from '@dicebound/game-core';
import { fixtureHub } from './fixtures.js';
export function fixtureInventory(
  hub: HubDTO = fixtureHub(),
  activeRunDieId: string | null = null,
): InventoryDTO {
  return {
    hub,
    activeRunDieId,
    powerScoreModel: POWER_SCORE_MODEL,
    policies: hub.inventory.dice.map((die) => ({
      dieId: die.id,
      equip: { allowed: !die.isEquipped, reason: die.isEquipped ? 'Уже в руке.' : null },
      dismantle: { ...dismantlePermission(die, activeRunDieId), dust: dismantleDust(die.rarity) },
      craft: SPHERE_TYPES.map((sphere) => {
        const reason =
          craftRejection(die, sphere)?.message ??
          ((hub.inventory.spheres.find((s) => s.type === sphere)?.amount ?? 0) > 0
            ? null
            : 'Нет сферы в кошельке.');
        return {
          sphere,
          cost: 1,
          allowed: !reason,
          reason,
          destructive: isDestructiveCraft(die, sphere),
        };
      }),
      masterFacet: (() => {
        const cost = masterFacetCost(die.ilvl);
        const reason =
          masterFacetRejection(die, 1, 'STRIKE')?.message ??
          (hub.player.facetDust < cost ? `Нужно ${cost} пыли граней.` : null);
        return { allowed: !reason, reason, cost };
      })(),
    })),
  };
}
