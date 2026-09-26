import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Path, Polyline, Rect } from 'react-native-svg';

import { colors } from '@/design/tokens';

/**
 * Original PaceLeague artwork, drawn from primitives (no third-party marks). Purely
 * decorative: every instance is hidden from assistive technology.
 */
function Decorative({ children }: { children: ReactNode }) {
  return <View aria-hidden>{children}</View>;
}

type Point = [number, number];

/** A filled ribbon along a cubic Bézier, tapering from `w0` to `w1` (clean, even lane edges). */
function ribbon(p0: Point, p1: Point, p2: Point, p3: Point, w0: number, w1: number, steps = 48): string {
  const at = (t: number): Point => {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  };
  const left: Point[] = [];
  const right: Point[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const [x, y] = at(t);
    const [x2, y2] = at(Math.min(1, t + 1e-3));
    const [x1, y1] = at(Math.max(0, t - 1e-3));
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const half = (w0 + (w1 - w0) * t) / 2;
    left.push([x + nx * half, y + ny * half]);
    right.push([x - nx * half, y - ny * half]);
  }
  const pts = [...left, ...right.reverse()].map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`);
  return `M ${pts.join(' L ')} Z`;
}

/** The "broken-lane P" monogram (same geometry as the app icon). */
export function Monogram({
  size = 28,
  color = colors.accent,
  background = colors.background,
}: {
  size?: number;
  color?: string;
  background?: string;
}) {
  return (
    <Decorative>
      <Svg width={size} height={size} viewBox="200 200 660 660">
        <G transform="translate(512 512) skewX(-12) translate(-512 -512)">
          <Path
            fillRule="evenodd"
            fill={color}
            d="M 330 230 H 610 C 725 230 800 305 800 420 C 800 535 725 610 610 610 H 470 V 794 H 330 Z M 470 350 V 490 H 600 C 645 490 665 460 665 420 C 665 380 645 350 600 350 Z"
          />
          <G fill={background}>
            <Rect x={310} y={660} width={170} height={26} transform="rotate(-24 395 673)" />
            <Rect x={310} y={724} width={170} height={26} transform="rotate(-24 395 737)" />
          </G>
        </G>
      </Svg>
    </Decorative>
  );
}

/** Track chevron for the Today tier card: dark lane chevrons behind a lime one. */
export function TierChevron({ width = 190, height = 200 }: { width?: number; height?: number }) {
  return (
    <Decorative>
      <Svg width={width} height={height} viewBox="0 0 190 200">
        {[0, 1, 2].map((i) => (
          <Polyline
            key={i}
            points={`${10 + i * 26},-10 ${95 + i * 26},100 ${10 + i * 26},210`}
            fill="none"
            stroke={i === 2 ? colors.decorativeDivider : colors.surfaceElevated}
            strokeWidth={14}
          />
        ))}
        <Polyline points="92,-10 176,100 92,210" fill="none" stroke={colors.accent} strokeWidth={40} strokeLinejoin="miter" />
      </Svg>
    </Decorative>
  );
}

/** Three forward-slanted lanes for the Progress tier card. */
export function SlantLanes({ width = 110, height = 84 }: { width?: number; height?: number }) {
  return (
    <Decorative>
      <Svg width={width} height={height} viewBox="0 0 110 84">
        {[0, 1, 2].map((i) => (
          <Path
            key={i}
            d={`M ${i * 30} 84 L ${34 + i * 30} 0 L ${50 + i * 30} 0 L ${16 + i * 30} 84 Z`}
            fill={colors.accent}
            opacity={1 - i * 0.12}
          />
        ))}
      </Svg>
    </Decorative>
  );
}

/** Welcome motif: three parallel lanes sweeping up and to the right, tapering into the distance. */
export function WelcomeLanes({ width = 350, height = 240 }: { width?: number; height?: number }) {
  const lanes: [Point, Point, Point, Point][] = [
    [
      [-6, 252],
      [30, 150],
      [120, 60],
      [292, 14],
    ],
    [
      [92, 252],
      [120, 168],
      [196, 96],
      [330, 50],
    ],
    [
      [190, 252],
      [206, 190],
      [262, 136],
      [356, 96],
    ],
  ];
  return (
    <Decorative>
      <Svg width={width} height={height} viewBox="0 0 350 240">
        {lanes.map(([p0, p1, p2, p3], i) => (
          <Path key={i} d={ribbon(p0, p1, p2, p3, 44 - i * 4, 12 - i * 2)} fill={colors.accent} />
        ))}
      </Svg>
    </Decorative>
  );
}

/** Share-poster motif: lime lanes sweeping across a black panel (no route, no map). */
export function PosterLanes({ width = 240, height = 240 }: { width?: number; height?: number }) {
  const lanes: [Point, Point, Point, Point][] = [
    [
      [-20, 214],
      [110, 176],
      [196, 120],
      [226, -20],
    ],
    [
      [-20, 168],
      [96, 136],
      [168, 90],
      [190, -20],
    ],
    [
      [-20, 122],
      [84, 98],
      [140, 62],
      [154, -20],
    ],
  ];
  return (
    <Decorative>
      <Svg width={width} height={height} viewBox="0 0 240 200" preserveAspectRatio="xMidYMid slice">
        <Rect x={-200} y={-200} width={640} height={600} fill={colors.background} />
        {lanes.map(([p0, p1, p2, p3], i) => (
          <Path key={i} d={ribbon(p0, p1, p2, p3, 22, 22)} fill={colors.accent} />
        ))}
      </Svg>
    </Decorative>
  );
}

/** Location dot used on preflight maps. */
export function LocationDot({ size = 28 }: { size?: number }) {
  return (
    <Decorative>
      <Svg width={size} height={size} viewBox="0 0 28 28">
        <Circle cx={14} cy={14} r={13} fill={colors.accent} opacity={0.25} />
        <Circle cx={14} cy={14} r={7} fill={colors.accent} stroke={colors.background} strokeWidth={2} />
      </Svg>
    </Decorative>
  );
}
