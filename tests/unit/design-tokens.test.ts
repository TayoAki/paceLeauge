import packet from '../../docs/packet/design-tokens.json';
import { colors, heights, layout, motion, radius, space, typeSizes, weights } from '@/design/tokens';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it('match the packet exactly', () => {
    expect(colors).toEqual(packet.color);
    expect(typeSizes).toEqual(packet.type.sizesPt);
    expect(weights).toEqual(packet.type.weights);
    expect(Object.values(space)).toEqual(packet.spacePt);
    expect(radius).toEqual(packet.radiusPt);
    expect({ primaryButtonMinimum: heights.primaryButton, runningPauseMinimum: heights.runningPause }).toEqual(packet.heightPt);
    expect(layout.screenPadding).toBe(packet.layout.screenPaddingPt);
    expect(layout.cardPadding).toBe(packet.layout.cardPaddingPt);
    expect(layout.minimumTapTarget).toBe(packet.layout.minimumTapTargetIosPt);
    expect({ standardMin: motion.standardMin, standardMax: motion.standardMax, optionalTierReveal: motion.tierReveal }).toEqual(packet.motionMs);
  });

  it('meet the documented contrast ratios (NFR-007)', () => {
    expect(contrast(colors.textPrimary, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textPrimary, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textSecondary, colors.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textSecondary, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.danger, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.controlOutline, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.textPrimary, colors.background)).toBeCloseTo(16.78, 1);
  });
});
