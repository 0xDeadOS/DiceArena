import { useId } from 'react';

const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
export function FlatDie({ face = 6, small = false }: { face?: number; small?: boolean }) {
  return (
    <span className={`flat-die ${small ? 'small' : ''}`} aria-label={`Грань ${face}`}>
      {Array.from({ length: 9 }, (_, index) => (
        <i key={index} className={PIPS[face]?.includes(index) ? 'pip visible' : 'pip'} />
      ))}
    </span>
  );
}

export function DieSculpture({ className = '' }: { className?: string }) {
  const id = useId().replaceAll(':', '');
  return (
    <svg
      className={`die-sculpture ${className}`}
      viewBox="0 0 360 370"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={`${id}-top`}
          x1="120"
          y1="55"
          x2="240"
          y2="190"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f3e2b4" />
          <stop offset="1" stopColor="#b59d70" />
        </linearGradient>
        <linearGradient
          id={`${id}-left`}
          x1="70"
          y1="120"
          x2="178"
          y2="280"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#d6c399" />
          <stop offset="1" stopColor="#a38c60" />
        </linearGradient>
        <linearGradient
          id={`${id}-right`}
          x1="180"
          y1="170"
          x2="290"
          y2="280"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9d8455" />
          <stop offset="1" stopColor="#6f5b3d" />
        </linearGradient>
        <radialGradient id={`${id}-aura`}>
          <stop stopColor="#b5a16c" stopOpacity=".16" />
          <stop offset="1" stopColor="#b5a16c" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-50%" y="-50%" width="200%" height="220%">
          <feDropShadow dx="0" dy="25" stdDeviation="15" floodColor="#050b07" floodOpacity=".7" />
        </filter>
        <pattern id={`${id}-texture`} width="39" height="31" patternUnits="userSpaceOnUse">
          <path
            d="m3 8 5-1m21 12 2-1M11 27h2"
            stroke="#2c2010"
            strokeOpacity=".12"
            strokeWidth=".6"
          />
        </pattern>
      </defs>
      <circle cx="180" cy="176" r="170" fill={`url(#${id}-aura)`} />
      <g stroke="#a39364" strokeOpacity=".2">
        <ellipse cx="179" cy="290" rx="145" ry="45" />
        <ellipse cx="179" cy="290" rx="122" ry="36" />
        <path d="m19 290 23-1m273 1h27M180 337v12M180 225v13" />
        <circle cx="180" cy="164" r="145" strokeDasharray="2 16" />
      </g>
      <g filter={`url(#${id}-shadow)`} className="floating-die">
        <path
          d="m82 111 87-51q9-5 18 0l87 51q10 6 0 13l-88 53q-8 5-17 0l-87-51q-13-8 0-15Z"
          fill={`url(#${id}-top)`}
          stroke="#e7d2a3"
          strokeWidth="1.2"
        />
        <path
          d="m76 120 96 57q6 3 6 11v110q-3 0-9-3l-86-52q-7-5-7-13Z"
          fill={`url(#${id}-left)`}
          stroke="#cfb98a"
          strokeWidth="1.2"
        />
        <path
          d="m178 184 101-62v108q0 9-7 14l-86 52q-4 2-8 2Z"
          fill={`url(#${id}-right)`}
          stroke="#a28b5e"
          strokeWidth="1.2"
        />
        <path
          d="m82 111 87-51q9-5 18 0l87 51 5 11v108q0 9-7 14l-86 52-8 2-9-3-86-52q-7-5-7-13V120Z"
          fill={`url(#${id}-texture)`}
        />
        <g fill="#51452e" stroke="#f4e0ad" strokeOpacity=".4">
          <ellipse cx="164" cy="93" rx="7" ry="4.3" transform="rotate(-30 164 93)" />
          <ellipse cx="144" cy="106" rx="7" ry="4.3" transform="rotate(-30 144 106)" />
          <ellipse cx="123" cy="119" rx="7" ry="4.3" transform="rotate(-30 123 119)" />
          <ellipse cx="227" cy="117" rx="7" ry="4.3" transform="rotate(-30 227 117)" />
          <ellipse cx="206" cy="131" rx="7" ry="4.3" transform="rotate(-30 206 131)" />
          <ellipse cx="185" cy="144" rx="7" ry="4.3" transform="rotate(-30 185 144)" />
          <ellipse cx="100" cy="162" rx="5" ry="8" transform="rotate(-30 100 162)" />
          <ellipse cx="152" cy="192" rx="5" ry="8" transform="rotate(-30 152 192)" />
          <ellipse cx="100" cy="218" rx="5" ry="8" transform="rotate(-30 100 218)" />
          <ellipse cx="152" cy="248" rx="5" ry="8" transform="rotate(-30 152 248)" />
        </g>
        <g fill="#352e20" stroke="#c2a772" strokeOpacity=".4">
          <ellipse cx="202" cy="191" rx="5" ry="8" transform="rotate(30 202 191)" />
          <ellipse cx="256" cy="160" rx="5" ry="8" transform="rotate(30 256 160)" />
          <ellipse cx="229" cy="216" rx="5" ry="8" transform="rotate(30 229 216)" />
          <ellipse cx="202" cy="267" rx="5" ry="8" transform="rotate(30 202 267)" />
          <ellipse cx="256" cy="236" rx="5" ry="8" transform="rotate(30 256 236)" />
        </g>
        <path d="m85 125 87 52m7 11v99m7-111 84-51" stroke="#ffe8b5" strokeOpacity=".3" />
      </g>
      <g fill="#c1ad75">
        <path d="m55 83 2 6 6 2-6 2-2 6-2-6-6-2 6-2Zm254 90 2 5 5 2-5 1-2 6-1-6-6-1 6-2Z" />
        <circle cx="286" cy="65" r="1.4" />
        <circle cx="43" cy="226" r="1.3" />
        <circle cx="247" cy="320" r="1.3" />
      </g>
    </svg>
  );
}
