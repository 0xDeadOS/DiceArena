import type { CSSProperties } from 'react';
import type { SphereType } from '@dicebound/shared-types';
import { SPHERES } from '../lib/catalog';

export function Orb({ type, small = false }: { type: SphereType; small?: boolean }) {
  const { color, icon: Icon } = SPHERES[type];
  return (
    <span
      className={`orb ${small ? 'small' : ''}`}
      style={{ '--orb-color': color } as CSSProperties}
      aria-hidden="true"
    >
      <Icon size={small ? 17 : 24} strokeWidth={1.35} />
    </span>
  );
}
